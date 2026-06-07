---
title: "Writing a Hypervisor - Part 2: UART, Interrupts & Running Linux"
description: "This series of blog posts mainly records my process of trying to implement a Hypervisor."
pubDate: "June 7, 2026"
word: 1630
time: "13 min"
cover: "https://cdn.ifarhan.tech/cdn/blog-cover/kvm.jpg"
tags: ["kvm", "linux", "c"]
---

This article is the second in the series. It will cover implementing interrupts and running our vCPU.

So far, we have an isolated space, a vCPU, and proper boot initialization of the Linux kernel via boot protocols.

## Interrupt and Timer

When building a hypervisor, you can't just ignore hardware interrupts. Even a virtualized guest OS expects standard x86 interrupt controllers to exist so it can receive timer ticks, disk I/O, and network signals.

In modern x86 hardware, interrupt routing is handled by a trio of components:

- **PIC** (8259A): The legacy controller. It handles 16 lines and only routes to a single CPU core. Modern operating systems disable it almost immediately after booting, but we still have to emulate it because the guest OS needs it during the early boot phase.
- **IOAPIC**: The modern, global router on the motherboard. It receives signals from modern hardware (like PCIe devices), checks its routing table, and dispatches a digital interrupt message to a specific CPU core.

- **LAPIC** (Local APIC): The receiver sitting inside every individual CPU core. It catches the messages sent by the IOAPIC, queues them, and physically halts the core's execution to handle the interrupt.

![x86_interrupt](https://cdn.ifarhan.tech/cdn/blog-inline/x86_interrupt_hardware.jpg)

We don't need to manually implement all three chips and their tables—KVM does it for us. We just need to tell it using ioctl.

```c
 // kvm struct for pit(timer)
 struct kvm_pit_config pit = {0};
 // Create IRQ chip for interrupt handling
  if (ioctl(self->vm_fd, KVM_CREATE_IRQCHIP, 0) < 0) {
    fprintf(stderr, "failed to create irqchip\n");
    return -1;
  }
  // Create PIT for timer interrupts
  if (ioctl(self->vm_fd, KVM_CREATE_PIT2, &pit) < 0) {
    fprintf(stderr, "failed to create pit\n");
    return -1;
  }

```

## Kvm Run Structure

Application code obtains a pointer to the kvm_run structure by mmap()ing a vCPU file descriptor. This is the most important struct in our VMM—all communication with the guest OS goes through this struct.

```c
 struct kvm_run *run = mmap(NULL, mmap_size, PROT_READ | PROT_WRITE,
                             MAP_SHARED, self->cpu_fd, 0);
  if (run == MAP_FAILED) {
    fprintf(stderr, "Failed to mmap kvm_run\n");
    return -1;
  }
  // Infinite loop to keep running the vCPU until it halts or errors out
  while (1) {
    if (ioctl(self->cpu_fd, KVM_RUN, 0) < 0) {
      fprintf(stderr, "KVM_RUN failed\n");
      return -1;
    }
    // Check why the vCPU exited
    switch (run->exit_reason) {
    case KVM_EXIT_HLT:
      break;
    case KVM_EXIT_IO:
      if ((run->io.port >= 0x3F8 && run->io.port <= 0x3FF) ||
          (run->io.port >= 0xF8 && run->io.port <= 0xFF)) {
        handle_serial(run);
      } else {
        printf("Unhandled I/O port 0x%x\n", run->io.port);
      }
      break;
    case KVM_EXIT_FAIL_ENTRY:
      fprintf(stderr, "KVM_EXIT_FAIL_ENTRY: hardware entry failure. Check your "
                      "segment registers.\n");
      return -1;
    case KVM_EXIT_INTERNAL_ERROR:
      fprintf(stderr, "KVM_EXIT_INTERNAL_ERROR: KVM kernel internal error.\n");
      return -1;
    case KVM_EXIT_MMIO:
      continue;
      break;
    case KVM_EXIT_SHUTDOWN:
      printf("KVM_EXIT_SHUTDOWN\n");
      munmap(run, mmap_size);
      return 0;
    default:
      printf("Unhandled KVM exit reason: %d\n", run->exit_reason);
      // Break out of the loop for unhandled exits so we don't spin endlessly
      return -1;
    }
  }
```

We keep it running in a while loop and make KVM_RUN calls via ioctl. It keeps running until a KVM_EXIT happens, which occurs whenever the guest OS requests a privileged instruction.

There can be multiple reasons why a KVM exit occurs, and based on that, we resolve it as you can see above. Most are self-explanatory, so I won't explain them all.
There are two important exits we need to handle:

- KVM_EXIT_IO
- KVM_EXIT_MMIO

In this part, I'll focus only on I/O exits. In the next article, we'll handle MMIO exits in detail.

So, to interact with I/O devices, there are two main ways: through I/O ports or memory-mapped I/O (MMIO). In real hardware, there are physical dedicated ports on the motherboard that are used to interact with legacy I/O devices. Modern I/O devices prefer the MMIO approach over I/O ports because of its simplification and data transfer speed. Legacy I/O devices include UART, keyboard, mouse, and legacy timers.

We're going to emulate UART serial ports using I/O ports, so read and write operations between the guest and the host are possible.

For a detailed explanation of UART, refer to https://www.lammertbies.nl/comm/info/serial-uart.

In short, there are I/O ports with dedicated memory addresses where the kernel reads or writes if there are `IN` or `OUT` assembly instructions at the real hardware level.

In virtualization, when the guest kernel requests any `IN` or `OUT` instruction, KVM intercepts it and a KVM_EXIT_IO happens. Control is then transferred to our VMM, and we have to resolve this exit based on the requested instruction.

## UART Serial Emulation

UART (Universal Asynchronous Receiver Transmitter) is the chip that handles serial communication. It's been around forever and every OS expects it to exist. For our hypervisor, we're going to emulate a 16550 UART, which uses I/O ports 0x3F8 to 0x3FF (and 0xF8 to 0xFF as aliases).

Each offset in that port range maps to a specific UART register:

- **Offset 0**: THR (Transmit Holding Register) for write, data written here gets printed to the host terminal. RBR (Receive Buffer Register) for reads, returns data from our input ring buffer.
- **Offset 1**: IER (Interrupt Enable Register) — controls which interrupts we care about. Bit 0 enables RX interrupts, bit 1 enables TX interrupts.
- **Offset 2**: IIR (Interrupt Identification Register) — read-only. Reports which interrupt is pending (RX data available > TX ready > none).

- **Offset 3**: LCR (Line Control Register) — controls line configuration. Bit 7 is DLAB (Divisor Latch Access Bit), which we use to switch offsets 0 and 1 to the baud rate divisor registers.
- **Offset 4**: MCR (Modem Control Register) — we store it but don't use it functionally.
- **Offset 5**: LSR (Line Status Register) — read-only. Reports RX/TX status. We always say TX is ready and RX is ready if the buffer has data.
- **Offset 6**: MSR (Modem Status Register) — read-only. We return fixed "ready/connected" signals.
- **Offset 7**: SCR (Scratch Register) — simple storage for the guest to use.

## Ring Buffer and Threading

To handle input from the host terminal while the guest is running, we spawn a separate input thread that reads from stdin in raw mode and pushes characters into a ring buffer. This way, the guest can read data whenever it's ready without blocking the vCPU.

```c
static uint8_t rx_buf[RX_BUF_SIZE];
static unsigned rx_head = 0;
static unsigned rx_tail = 0;

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void buf_push(uint8_t c) {
  if (!buf_full()) {
    rx_buf[rx_head] = c;
    rx_head = (rx_head + 1) % RX_BUF_SIZE;
  }
}

static uint8_t buf_pop() {
  uint8_t c = rx_buf[rx_tail];
  rx_tail = (rx_tail + 1) % RX_BUF_SIZE;
  return c;
}
```

We use a circular buffer so we don't need to shift data around. The input thread continuously reads from stdin and pushes characters. When the guest reads from RBR (offset 0), we pop a character from the buffer. A mutex protects all buffer operations from race conditions.

## Interrupt Management

We emulate two types:

1. **RX Interrupt (RDA)**: Triggered when the RX buffer has data and the guest has enabled RX interrupts (IER bit 0 = 1).
2. **TX Interrupt (THRE)**: Triggered when the guest writes to THR and has enabled TX interrupts (IER bit 1 = 1).

We send interrupts to the guest via `KVM_IRQ_LINE` ioctl, signaling IRQ 4 (the standard serial port IRQ).

```c
static int irq_level = 0;    /* the level we last sent to KVM for IRQ4   */
static int thre_pending = 0; /* THRE interrupt waiting for IIR read       */

static void update_irq() {
  int rx_int = !buf_empty() && (uart_ier & 0x01);
  int tx_int = thre_pending && (uart_ier & 0x02);
  int want = 0;
  if (rx_int || tx_int)
    want = 1;

  if (want != irq_level) {
    struct kvm_irq_level irq = {.irq = 4, .level = want};
    ioctl(vm_fd, KVM_IRQ_LINE, &irq);
    irq_level = want;
  }
}
```

In `update_irq`, we determine which interrupts the guest is requesting. If the ring buffer is not empty and the guest has set bit 0 of IER, it is an RX interrupt.  
`thre_pending` represents whether a THRE interrupt is owed to the guest but not yet acknowledged. It is set to 1 when the guest writes a byte to THR meaning the VMM has accepted the byte and the transmit register is now empty again, ready for another write. Since our emulation writes to stdout instantly, THR is always physically empty, so `thre_pending` exists purely as a oneshot flag to track that we owe the guest a TX interrupt. It is cleared when the guest reads IIR, which serves as the acknowledgment.  
If `thre_pending` is set and the guest has enabled bit 1 of IER, it is a TX interrupt.
If either `rx_int` or `tx_int` is active, we set `want` to 1. We then compare it against `irq_level` — the last level we sent to KVM. Only if the level has changed do we call `ioctl()` to signal IRQ 4 and update `irq_level`. This prevents redundant and unnecessary interrupt calls.

## Raw Terminal Mode

For the guest to interact properly with the terminal, we need to put the host terminal into raw mode. This disables line buffering, echo, signal handling, and flow control so that every keystroke goes directly to the guest.

```c
static void serial_set_raw() {
  if (!isatty(STDIN_FILENO))
    return;

  tcgetattr(STDIN_FILENO, &orig_termios);
  atexit(restore_terminal);

  struct termios raw = orig_termios;
  raw.c_iflag &= ~(ICRNL | IXON);
  raw.c_oflag &= ~(OPOST);
  raw.c_lflag &= ~(ECHO | ICANON | ISIG | IEXTEN);
  raw.c_cc[VMIN] = 1;
  raw.c_cc[VTIME] = 0;

  tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw);
  terminal_raw = 1;
}
```

We keep the original termios and restore it at exit. The key flags we disable are:

- **ICANON**: Disables line buffering so we don't wait for Enter.
- **ECHO**: Disables host echo. The guest will echo keys back through THR.
- **ISIG**: Disables Ctrl-C and Ctrl-Z handling by the host. These travel to the guest as raw bytes.
- **IXON/ICRNL/OPOST**: Disables flow control and line ending translation by the host.

This way, everything typed goes to the guest as-is.

## Handling I/O Operations

When a KVM_EXIT_IO happens, we look at the port and direction to figure out what to do. For UART ports, we call `handle_serial()`.

```c
void handle_serial(struct kvm_run *run) {
  uint8_t *io_data = (uint8_t *)run + run->io.data_offset;
  int offset = run->io.port & 0x7; // extract last 3 bits
  int dlab = uart_lcr & 0x80;      // (0x80 -> 1000 0000)

  if (run->io.direction == KVM_EXIT_IO_OUT) {
    // guest writes
  } else {
    // guest reads
  }
}
```

`OUT` direction is when guest wants to write to uart serial port, kvm intercepts the instruction and cause exit and fill kvm run struct.
`IN` direction is when guest wants to read from uart serial port. The VMM must place the response bytes into the I/O data buffer so KVM can copy them back into the guest CPU register when execution resumes.

```c
struct {
#define KVM_EXIT_IO_IN  0
#define KVM_EXIT_IO_OUT 1
			__u8 direction;
			__u8 size; /* bytes */
			__u16 port;
			__u32 count;
			__u64 data_offset; /* relative to kvm_run start */
		} io;
```

`port` tells the offset and `data_offset` is an offset relative to the start of `kvm_run`. Adding it to the base address of run gives a pointer to the actual I/O data buffer.

### Write Operations (Guest → Host)

When the guest writes to THR (offset 0), we write it to stdout.

```c
case 0: // THR
  write(STDOUT_FILENO, io_data, run->io.count);
  pthread_mutex_lock(&lock);
  if (uart_ier & 0x02) {
    thre_pending = 1;
    update_irq(); // tx interrupt
  }
  pthread_mutex_unlock(&lock);
  break;
```

If TX interrupts are enabled, we set a flag and call `update_irq()` to signal the guest that the register is now empty (which is always true in our emulation since we write instantly).

When the guest writes to IER (offset 1), we update which interrupts are enabled and re-evaluate the interrupt state:

```c
case 1: // IER
  pthread_mutex_lock(&lock);
  uart_ier = *io_data;
  if (uart_ier & 0x02) {
    thre_pending = 1;
  }
  update_irq();
  pthread_mutex_unlock(&lock);
  break;
```

If DLAB is set, offsets 0 and 1 map to the baud rate divisor registers (DLL and DLH). We store the values but don't use them, Linux just expects them to exist.

```c
if (dlab && (offset == 0 || offset == 1)) {
      if (offset == 0) {
        uart_dll = *io_data;
      } else if (offset == 1) {
        uart_dlh = *io_data;
      }
      return;
    }
```

### Read Operations (Host → Guest)

When the guest reads from RBR (offset 0), we pop from the ring buffer:

```c
case 0: // RBR
  pthread_mutex_lock(&lock);
  *io_data = buf_empty() ? 0x00 : buf_pop();
  update_irq();
  pthread_mutex_unlock(&lock);
  break;
```

After popping (or returning 0 if empty), we call `update_irq()`. If the buffer is now empty, the RX interrupt will be lowered.

When the guest reads from IIR (offset 2), we report which interrupt is pending:

```c
case 2: // IIR
  pthread_mutex_lock(&lock);
  if (!buf_empty() && (uart_ier & 0x01)) {
    *io_data = 0x04; // rx: data available in ring buffer
  } else if (thre_pending) {
    *io_data = 0x02; // Transmit Holding Register Empty
  } else
    *io_data = 0x01; // no interrupt pending
  if (*io_data == 0x02) {
    thre_pending = 0;
    update_irq();
  }
  pthread_mutex_unlock(&lock);
  break;
```

RX takes priority over TX. When we report a TX interrupt, we also clear the `thre_pending` flag since reading IIR acknowledges the interrupt.

When the guest reads LSR (offset 5), we report status:

```c
case 5: // LSR
  pthread_mutex_lock(&lock);
  *io_data = 0x60 | (buf_empty() ? 0x00 : 0x01);
  pthread_mutex_unlock(&lock);
  break;
```

Bits 5 and 6 are always 1 (TX ready and shift register empty). Bit 0 reflects whether the RX buffer has data. This tells the guest it can write to THR and whether there's data to read.

## Putting It Together

During initialization, we call `serial_init()` to set up raw terminal mode and spawn the input thread. Then, as the vCPU runs, whenever it does an `IN` or `OUT` instruction on a serial port, KVM exits and we handle it in `handle_serial()`.

The guest OS boots up, probes the UART, sets up interrupts, and starts using it for console I/O. When it writes text, we print it. When you type on the host terminal, characters flow into the ring buffer, trigger RX interrupts, and the guest reads them.

Full src code of serial implementation [here](https://gist.github.com/Farhan291/cadca9d0645047fe4725874778f89415)

Now our hypervisor is ready to boot up actual linux kernel. Just grab bzImage and initrd and boot up.

here screenshot of me booting up alpine linux

![alpine](https://cdn.ifarhan.tech/cdn/blog-inline/vmm.jpg)

for video you can checkout my post on twitter [here](https://x.com/mkdir_autisim/status/2047359757867225371)

In Next part we will implement MMIO and VIRTIO for emulating peripheral devices.
