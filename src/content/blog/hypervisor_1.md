---
title: "Writing a Hypervisor - Part 1: KVM, vCPU Setup & Loading Linux"
description: "This series of blog posts mainly records my process of trying to implement a Hypervisor."
pubDate: "April 24, 2026"
word: 1560
time: "12 min"
cover: "https://cdn.ifarhan.tech/cdn/blog-cover/kvm.jpg"
tags: ["Kvm", "linux", "C"]
---

Recently, I was exploring Proxmox. Before that, I wasn't very familiar with virtualization, so I started exploring KVM and QEMU.  
But things changed when I came across the Firecracker hypervisor, which actually creates **microVMs** (which are used in AWS Lambda serverless architecture) instead of full-fledged VMs, unlike other hypervisors. This got me excited that a hypervisor doesn't necessarily have to be that complex. This inspired the idea of building one myself.   

This is the first article in the series, covering how KVM works, setting up a vCPU in 32-bit protected mode, and loading a Linux bzImage with initrd into guest memory.  
Keep in mind: KVM itself is the hypervisor (the kernel part), but what we're building is actually a userspace Virtual Machine Monitor(VMM) - the orchestrator that sits on top of KVM.


## Basic Knowledge
First, what exactly is KVM? Kernel-based Virtual Machine (KVM) is a Linux kernel module that turns your kernel into a hypervisor. You might wonder: if KVM is already a hypervisor, what are we building? Here's the thing, KVM only handles the low-level CPU execution and memory isolation. It doesn't know how to emulate I/O devices like disks, network interfaces, etc. So we need to build a userspace VMM (Virtual Machine Monitor) that sits on top of KVM and handles all that emulation work. 


So how do we use KVM? The Linux kernel exposes KVM as a device file in `/dev/kvm`. Our userspace VMM opens this file and talks to it using the `ioctl` syscall. There are three levels here:
1. System: affects the entire KVM subsystem, such as creating VMs.
2. VM: affects a single VM, such as creating a vCPU for the VM.
3. vCPU: queries or controls the properties of a single vCPU.

Our userspace VMM uses KVM to create:
- Virtual machine — the isolated memory space for the guest OS
- Virtual CPU — the CPU the guest OS will run on
- IRQ chip — interrupt controller to handle guest interrupts
- PIT — programmable interval timer to emulate system clock


## Creating the Virtual Machine 

Let's create our vm.
```c 
#define MEMORY_SIZE (1024 * 1024 * 1024) // 1GB
struct guest_mem_map {
  void *host_mem;
  uint64_t size;
};
struct vmm {
  int kvm_fd;
  int vm_fd;
  int cpu_fd;
  struct guest_mem_map *mem_map;
};

int main() {
  struct vmm vm = {0};
  struct vmm *self = &vm;
  struct kvm_userspace_memory_region mem = {0};
  struct kvm_pit_config pit = {0};

  // open kvm device
  self->kvm_fd = open("/dev/kvm", O_RDWR);
  if (self->kvm_fd < 0) {
    fprintf(stderr, "failed to open /dev/kvm\n");
    return -1;
  }
  // create vm
  self->vm_fd = ioctl(self->kvm_fd, KVM_CREATE_VM, 0);
  if (self->vm_fd < 0) {
    fprintf(stderr, "failed to create vm\n");
    return -1;
  }
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

  struct guest_mem_map *mem_map =
      (struct guest_mem_map *)malloc(sizeof(struct guest_mem_map));

  if (!mem_map) {
    fprintf(stderr, "failed to allocate PhysMemoryMap\n");
    return -1;
  }
  mem_map->size = MEMORY_SIZE;
  // get memory for vm
  mem_map->host_mem = mmap(NULL, mem_map->size, PROT_READ | PROT_WRITE,
                           MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

  if (mem_map->host_mem == MAP_FAILED) {
    fprintf(stderr, "failed to mmap memory\n");
    return -1;
  }

  self->mem_map = mem_map;
  mem.slot = 0;
  mem.guest_phys_addr = 0x0;
  mem.memory_size = MEMORY_SIZE;
  mem.userspace_addr = (uint64_t)mem_map->host_mem;
  // map the process memory to vm memory
  if (ioctl(self->vm_fd, KVM_SET_USER_MEMORY_REGION, &mem) < 0) {
    fprintf(stderr, "failed to set user memory region\n");
    return -1;
  }
  // create vcpu for vm
  self->cpu_fd = ioctl(self->vm_fd, KVM_CREATE_VCPU, 0);
  if (self->cpu_fd < 0) {
    fprintf(stderr, "failed to create vcpu\n");
    return -1;
  }
```

Straightforward stuff here. We open `/dev/kvm`, talk to KVM with `ioctl`, and create a VM with `KVM_CREATE_VM`. Then we set up the IRQ chip and PIT with `KVM_CREATE_IRQCHIP` and `KVM_CREATE_PIT2`. Finally, we allocate memory with `malloc`, map it with `mmap`, and tell KVM about it with `KVM_SET_USER_MEMORY_REGION`. That's our userspace VMM setting up the stage for the guest OS to run.

## CPU Modes

Before moving further, I'll explain how a real CPU boots Linux.

When the CPU powers on, it starts in 16-bit real mode for backward compatibility with the Intel 8086. The bootloader then initializes the CPU registers and switches to 32-bit protected mode, where it follows the x86 Linux boot protocol, loads the bzImage (kernel) and initramfs, and finally switches to 64-bit long mode, handing execution to the kernel.

Now, from which mode do we start?

If we choose to start the kernel from the 16-bit entry point, it means we must implement BIOS emulation, which sounds incredibly tedious. On the other hand, if we start from the 64-bit entry point, we must first put the CPU into 64-bit mode. However, 64-bit mode on x86 CPUs requires paging to be enabled, so we would also have to handle memory mapping and create page tables first.

In comparison, the 32-bit entry point is much simpler. It does not require a BIOS, nor does it require setting up paging. Although our Linux kernel is 64-bit, the Linux kernel itself will handle enabling paging and switching to 64-bit mode for us; we don't need to worry about it. Since we are here to write a virtual machine manager, not a bootloader or an operating system, naturally, starting from the 32-bit entry point is the best choice.

To enter protected mode on real hardware, there's a complex initialization process. Details can be found on [OSDev](https://wiki.osdev.org/Protected_Mode).

In real hardware, memory access goes through segment registers:

CS, SS, DS, ES, FS, GS

Each instruction contains only an offset; the segment's hidden part is fetched from the Global Descriptor Table (GDT), which holds the base address, limit, and access information. The physical address is then:

`pa = seg.base + offset`

So do we need to build a temporary GDT like bootloaders do? Nah we play here smartly, Instead of making the vCPU look up the GDT, we directly initialize the segment registers using KVM APIs, so the CPU already knows the hidden parts of each segment without a GDT lookup.

There are different memory models, but modern OSes in protected mode use the flat memory model.

In flat mode, every segment has `base = 0` and `limit = 0xffffffff`, so the physical address is effectively just the offset. We don't set up a GDT we initialize the segments directly, and the Linux kernel will plug in its own GDT later.

![Protected Mode Flat Model](https://cdn.ifarhan.tech/cdn/blog-inline/proctedmode.png)

![Segment descriptor](https://cdn.ifarhan.tech/cdn/blog-inline/segdesc.png)

```c
void set_flat_mode(struct kvm_segment *seg) {
  seg->base = 0;
  seg->limit = 0xffffffff; // max limit 32bit
  seg->g = 1;              // 4KB granularity
  seg->db = 1;             // 32-bit
  seg->present = 1;        // MUST be set
  seg->s = 1;              // code/data (not system)
  seg->dpl = 0;            // ring 0
  seg->type = 3;           // read/write, accessed
}

void set_cs_flat(struct kvm_segment *seg) {
  seg->base = 0;
  seg->limit = 0xffffffff; // max limit 32bit
  seg->g = 1;              // 4KB granularity
  seg->db = 1;             // 32-bit
  seg->present = 1;        // MUST be set
  seg->s = 1;              // code/data (not system)
  seg->dpl = 0;            // ring 0
  seg->type = 11;          // read, accessed and exec
}
```
Segment registers map to the `kvm_segment` structure. We set `base` to 0 and `limit` to `0xffffffff` for flat mode. `g = 1` means the limit is in 4KB units. `db = 1` tells the CPU it's 32-bit protected mode. The `present` bit marks the segment as valid. `s = 1` means it's a code/data segment, not a system segment. `dpl = 0` means ring 0 (kernel privilege). The `type` field describes the segment's capabilities—read/write for data segments, execute/read for code.

## CPU Intialization 

```c
  struct kvm_sregs sregs = {0};
  struct kvm_regs regs = {0};
  // intialiaze all special register
  if ((ioctl(cpu_fd, KVM_GET_SREGS, &sregs)) < 0) {
    fprintf(stderr, "failed to get sregs\n");
    return -1;
  }
  // intialize all general purpose registers
  if (ioctl(cpu_fd, KVM_GET_REGS, &regs) < 0) {
    fprintf(stderr, "failed to get regs.\n");
    return -1;
  }
  // set all segement special register according to flat memory model
  set_cs_flat(&sregs.cs);
  set_flat_mode(&sregs.ds);
  set_flat_mode(&sregs.es);
  set_flat_mode(&sregs.fs);
  set_flat_mode(&sregs.gs);
  set_flat_mode(&sregs.ss);

  sregs.cr0 |= 0x1; // sets cpu to protected mode (32bit)
  regs.rip = 0x100000;
  regs.rsi = 0x10000;
  regs.rflags = 0x2;

  // set sregs
  if (ioctl(cpu_fd, KVM_SET_SREGS, &sregs) < 0) {
    fprintf(stderr, "failed to set sregs.\n");
    return -1;
  }
  // set regs
  if (ioctl(cpu_fd, KVM_SET_REGS, &regs) < 0) {
    fprintf(stderr, "failed to set regs.\n");
    return -1;
  }

```
registers and special registers of vCPU maps to `kvm_regs` and `kvm_sregs` struct , kvm first fill it with all default initial values then we change segment registers according to our flat mode and set special register `cr0` last bit to 1 to set protected mode.  
the `rip` register needs to be set to `0x100000` kernel entry point will be loaded at this location, and the CPU will start from here. The `rsi` register needs to be set to `0x10000`; the kernel boot parameters(zeropage) will be loaded at this location.

The final step is setting up CPUID. We retrieve the CPUID features supported by KVM from the KVM API and then set them for the virtual CPU:
```c
struct kvm_cpuid2 *cpuid;
int max_entries = 100;
cpuid = (struct kvm_cpuid2 *)malloc(
      sizeof(*cpuid) + max_entries * sizeof(struct kvm_cpuid_entry2));
cpuid->nent = max_entries;
ioctl(kvm_fd, KVM_GET_SUPPORTED_CPUID, cpuid);
ioctl(cpu_fd, KVM_SET_CPUID2, cpuid);
```
Thus, the CPU initialization is complete. 

## Loading Kernel

Linux kernel comes in a compressed form called bzImage. Traditionally, every 512 bytes on the disk is referred to as a "sector." The first 512 bytes are the boot sector (real mode setup code). Following that are several sectors of setup parameters (setup). After that comes the actual compressed kernel (kernel). As illustrated below:

```
+------------------------+
|  Kernel boot sector    |      <- size of 512 bytes
+------------------------+
|  Kernel setup          |      <- size of n*512 bytes
+------------------------+
|  Compressed vmlinux    |      <- size of m*16 bytes
+------------------------+
|  CRC                   |      <- size of 4 bytes
|                        |         
|                        |         
+------------------------+
```
We skip the boot sector since we're jumping directly to 32-bit protected mode. Instead, we need to copy boot parameters (zeropage) to the memory location that register `rsi` points to. We load the bzImage into memory and read the kernel header at offset `0x01f1` as defined by the Linux boot protocol.
First, we map the bzImage into memory:
```c
void *map_file(const char *path, size_t *size) {
  struct stat st = {0};
  int fd = open(path, O_RDONLY);
  if (fd < 0) {
    fprintf(stderr, "open failed\n");
    return NULL;
  }
  if (fstat(fd, &st) < 0) {
    fprintf(stderr, "fstat failed\n");
    close(fd);
    return NULL;
  }
  // load bzimage into memory
  void *addr = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (addr == MAP_FAILED) {
    fprintf(stderr, "mmap failed\n");
    return NULL;
  }
  close(fd);
  *size = st.st_size;
  return addr;
}
size_t bzimage_size = 0;
size_t initrd_size = 0;
struct boot_params *zeropage = NULL;
void *bzimage = map_file(kernel_path, &bzimage_size);
if (bzimage == NULL) {
  fprintf(stderr, "failed to load kernel\n");
  return;
}
```
Now copy the kernel header to zeropage:
```c
// setup boot parameters
zeropage = (struct boot_params *)((uint8_t *)vm->mem_map->host_mem + 0x10000);
memset(zeropage, 0, sizeof(struct boot_params));
// copy kernel header from bzimage to zeropage hdr  , hdr start at offset of 0x01f1
memcpy(&zeropage->hdr, (uint8_t *)bzimage + 0x01f1, sizeof(zeropage->hdr));
```
Now we need to set up the **e820 map**, which tells the kernel which memory regions are available and which are reserved.
```c
void setup_e820_map(struct boot_params *zeropage, struct vmm *vm) {
  zeropage->e820_entries = 2;
  // low memory (0->640KB)
  zeropage->e820_table[0].addr = 0x0;
  zeropage->e820_table[0].size = 0xA0000;
  zeropage->e820_table[0].type = 1;  // available
  // 0xA0000 -> 0x100000 (reserved)
  // high memory (1MB -> end)
  zeropage->e820_table[1].addr = 0x100000;
  zeropage->e820_table[1].size = vm->mem_map->size - 0x100000;
  zeropage->e820_table[1].type = 1;  // available
}
```
Boot parameters have different access modes: some are read-only (kernel to bootloader), some need to be filled by the bootloader ("write"), and some are read-modify. We need to set the important ones:
```c
zeropage->hdr.type_of_loader = 0xff;
zeropage->hdr.vid_mode = 0xFFFF;
zeropage->hdr.loadflags |= LOADED_HIGH;
```
We set `type_of_loader` to `0xff` (experimental bootloader), the graphics mode to `0xFFFF` (default), and `loadflags` to `LOADED_HIGH`.
```c
// kernel command-line arguments
const char *kernel_args = "console=ttyS0 debug";
char *cmd_line = (char *)((uint8_t *)vm->mem_map->host_mem + 0x20000);
zeropage->hdr.cmd_line_ptr = 0x20000;
memcpy(cmd_line, kernel_args, strlen(kernel_args) + 1);
```
Kernel command-line arguments are passed during boot. You can store them anywhere in available memory—I chose `0x20000`.

Additionally, we need to load an initial RAM disk (initrd) for system initialization. The placement is flexible—I store it at the end of the memory region:
```c
void load_initrd(const char *initrd_path, struct vmm *vm, size_t *size,
                 struct boot_params *zeropage) {
  struct stat st = {0};
  int fd = open(initrd_path, O_RDONLY);
  if (fd < 0) {
    perror("open initrd");
    exit(1);
  }
  if (fstat(fd, &st) < 0) {
    perror("fstat initrd");
    close(fd);
    exit(1);
  }
  void *initrd = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (initrd == MAP_FAILED) {
    perror("mmap initrd");
    close(fd);
    exit(1);
  }
  uint32_t initrd_addr = vm->mem_map->size - st.st_size;
  initrd_addr &= ~(4096 - 1); // align to 4KB page boundary
  *size = st.st_size;
  memcpy((uint8_t *)vm->mem_map->host_mem + initrd_addr, initrd, st.st_size);
  zeropage->hdr.ramdisk_image = initrd_addr;
  zeropage->hdr.ramdisk_size = st.st_size;
  munmap(initrd, st.st_size);
  close(fd);
}
```
Finally, we load the compressed kernel to the memory location where register `rip` points (`0x100000`):
```c
// copy the compressed kernel from bzimage to vm address(0x100000)
uint32_t setup_size = (zeropage->hdr.setup_sects + 1) * 512;
memcpy((uint8_t *)vm->mem_map->host_mem + 0x100000,
       (uint8_t *)bzimage + setup_size, bzimage_size - setup_size);
```
The `setup_sects` field tells us how many 512-byte sectors are used by the setup code (excluding the boot sector). We add 1 to include the boot sector itself.
## Conclusion

Our VM memory layout :
```
+------------------------+
|        Initrd          |  <- placed at end of guest RAM
+------------------------+
|                        |
|     Free Memory        |
|                        |
+------------------------+
|  Compressed Kernel     |  <- loaded at 0x100000 (RIP)
|    (bzImage payload)   |
+------------------------+
|   Reserved (IO)        |  <- 0xA0000 - 0x100000
+------------------------+
|   Kernel Cmdline       |  <- 0x20000
+------------------------+
|  boot_params (zero)    |  <- 0x10000 (RSI)
+------------------------+
|     Low Memory         |  <- usable RAM (e820)
+------------------------+
```

We have now fully setup virtual CPU and properly loaded x86 linux bzImage and initramfs into memory of our VM all according to x86 linux boot protocols.

I will end this blog, in next part we will run the VM machine and implement serial ports and interrupts.
