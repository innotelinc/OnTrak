/**
 * Emit a tiny, real ELF64 x86-64 executable for the Ghidra tool tests.
 *
 * The machines that run this suite do not all have a cross-compiler, so the
 * fixture is assembled byte for byte instead of compiled: an ELF header, one
 * PT_LOAD program header, and a two-syscall `write` + `exit` body. Ghidra
 * imports it as an ordinary executable, which is all the test needs.
 *
 * Usage: node ghidra/make-test-binary.mjs [outfile]
 */

import { writeFileSync } from 'node:fs'

const outfile = process.argv[2] ?? new URL('./fixtures/ghidra-probe-x86_64', import.meta.url)

const message = Buffer.from('ontrak-genie ghidra probe: ELF64 x86-64\n')

const EHDR = 64
const PHDR = 56
const CODE_OFFSET = EHDR + PHDR // 120
const BASE = 0x400000

// b8 01.. mov eax,1 (write) | bf 01.. mov edi,1 | 48 8d 35 .. lea rsi,[rip+msg]
// ba .. mov edx,len | 0f 05 syscall | b8 3c.. mov eax,60 | 31 ff xor edi,edi | 0f 05
const prefix = Buffer.concat([
  Buffer.from([0xb8, 0x01, 0x00, 0x00, 0x00]),
  Buffer.from([0xbf, 0x01, 0x00, 0x00, 0x00]),
  Buffer.from([0x48, 0x8d, 0x35, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0xba, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0x0f, 0x05]),
  Buffer.from([0xb8, 0x3c, 0x00, 0x00, 0x00]),
  Buffer.from([0x31, 0xff]),
  Buffer.from([0x0f, 0x05])
])

// Layout inside `prefix`: [0..4] mov eax,1 | [5..9] mov edi,1 | [10..16] lea rsi
// (ModRM at 12, disp32 at 13) | [17..21] mov edx,imm (imm32 at 18).
const messageOffset = CODE_OFFSET + prefix.length
prefix.writeUInt32LE(message.length, 18) // mov edx, len
const leaNext = CODE_OFFSET + 5 + 5 + 7
prefix.writeInt32LE(messageOffset - leaNext, 13) // lea rip displacement

const total = CODE_OFFSET + prefix.length + message.length

const ehdr = Buffer.alloc(EHDR)
ehdr.write('\u007fELF', 0, 'latin1')
ehdr[4] = 2 // ELFCLASS64
ehdr[5] = 1 // ELFDATA2LSB
ehdr[6] = 1 // EV_CURRENT
ehdr.writeUInt16LE(2, 16) // ET_EXEC
ehdr.writeUInt16LE(0x3e, 18) // EM_X86_64
ehdr.writeUInt32LE(1, 20) // EV_CURRENT
ehdr.writeBigUInt64LE(BigInt(BASE + CODE_OFFSET), 24) // entry
ehdr.writeBigUInt64LE(BigInt(EHDR), 32) // phoff
ehdr.writeBigUInt64LE(0n, 40) // shoff
ehdr.writeUInt32LE(0, 48) // flags
ehdr.writeUInt16LE(EHDR, 52) // ehsize
ehdr.writeUInt16LE(PHDR, 54) // phentsize
ehdr.writeUInt16LE(1, 56) // phnum
ehdr.writeUInt16LE(0, 58) // shentsize
ehdr.writeUInt16LE(0, 60) // shnum
ehdr.writeUInt16LE(0, 62) // shstrndx

const phdr = Buffer.alloc(PHDR)
phdr.writeUInt32LE(1, 0) // PT_LOAD
phdr.writeUInt32LE(5, 4) // PF_R | PF_X
phdr.writeBigUInt64LE(0n, 8) // offset
phdr.writeBigUInt64LE(BigInt(BASE), 16) // vaddr
phdr.writeBigUInt64LE(BigInt(BASE), 24) // paddr
phdr.writeBigUInt64LE(BigInt(total), 32) // filesz
phdr.writeBigUInt64LE(BigInt(total), 40) // memsz
phdr.writeBigUInt64LE(0x1000n, 48) // align

writeFileSync(outfile, Buffer.concat([ehdr, phdr, prefix, message]))
console.log(`wrote ${outfile.toString?.() ?? outfile} (${total} bytes)`)
