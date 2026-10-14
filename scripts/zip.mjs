// 最小 ZIP 写入器（store 方式，不压缩）。
//
// 为什么自己写：Node 没有内置 zip 写入能力，而打包脚本需要「可重跑、无外部依赖」。
// 源码总量只有几百 KB，不压缩完全可接受；ZIP 的 store 方式格式最简单、最容易核对。
// 只实现打包需要的最小子集：单个文件、UTF-8 名字、无加密、无 Zip64（本包远小于 4 GB）。
import { Buffer } from 'node:buffer'

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_SIGNATURE = 0x06054b50
const UTF8_FLAG = 0x0800

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/** DOS 时间/日期。用固定值：打包结果可复现，不受打包时刻影响。 */
const DOS_TIME = 0
const DOS_DATE = 33 // 1980-01-01

export class ZipArchive {
  #stream
  #entries = []
  #finished = false

  constructor(stream) {
    this.#stream = stream
  }

  /** 加入一个文件。name 用 `/` 分隔的相对路径。 */
  add(name, bytes) {
    if (this.#finished) throw new Error('zip 已结束，不能再加文件')
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    this.#entries.push({ name, nameBytes, data, crc: crc32(data) })
  }

  async finish() {
    if (this.#finished) throw new Error('zip 已结束')
    this.#finished = true
    const chunks = []
    const centralChunks = []
    let offset = 0

    for (const entry of this.#entries) {
      const local = Buffer.alloc(30)
      local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
      local.writeUInt16LE(20, 4) // version needed
      local.writeUInt16LE(UTF8_FLAG, 6)
      local.writeUInt16LE(0, 8) // store
      local.writeUInt16LE(DOS_TIME, 10)
      local.writeUInt16LE(DOS_DATE, 12)
      local.writeUInt32LE(entry.crc, 14)
      local.writeUInt32LE(entry.data.length, 18)
      local.writeUInt32LE(entry.data.length, 22)
      local.writeUInt16LE(entry.nameBytes.length, 26)
      local.writeUInt16LE(0, 28)
      chunks.push(local, entry.nameBytes, entry.data)

      const central = Buffer.alloc(46)
      central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0)
      central.writeUInt16LE(20, 4) // version made by
      central.writeUInt16LE(20, 6) // version needed
      central.writeUInt16LE(UTF8_FLAG, 8)
      central.writeUInt16LE(0, 10)
      central.writeUInt16LE(DOS_TIME, 12)
      central.writeUInt16LE(DOS_DATE, 14)
      central.writeUInt32LE(entry.crc, 16)
      central.writeUInt32LE(entry.data.length, 20)
      central.writeUInt32LE(entry.data.length, 24)
      central.writeUInt16LE(entry.nameBytes.length, 28)
      central.writeUInt16LE(0, 30) // extra
      central.writeUInt16LE(0, 32) // comment
      central.writeUInt16LE(0, 34) // disk start
      central.writeUInt16LE(0, 36) // internal attrs
      central.writeUInt32LE(0, 38) // external attrs
      central.writeUInt32LE(offset, 42)
      centralChunks.push(central, entry.nameBytes)

      offset += local.length + entry.nameBytes.length + entry.data.length
    }

    const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_OF_CENTRAL_SIGNATURE, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(this.#entries.length, 8)
    end.writeUInt16LE(this.#entries.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(offset, 16)
    end.writeUInt16LE(0, 20)

    for (const chunk of [...chunks, ...centralChunks, end]) {
      if (!this.#stream.write(chunk)) {
        await new Promise((resolve) => this.#stream.once('drain', resolve))
      }
    }
    await new Promise((resolve, reject) => {
      this.#stream.end((error) => (error ? reject(error) : resolve()))
    })
  }
}
