#!/usr/bin/env node
/**
 * ownshield asar 工具（零依赖，仅 Node 标准库）
 *
 * 用法:
 *   node asar.mjs list <asar>
 *   node asar.mjs extract <asar> <outDir>
 *   node asar.mjs pack <dir> <outAsar>
 *
 * 本版归档结构（@electron/asar pickle）:
 *   [0..4)    u32 = 4                      size pickle 固定 4 字节负载
 *   [4..8)    u32 = headerBuf 长度（含自身 4 字节长度前缀）
 *   [8..)     headerBuf = u32(payloadLen) + u32(jsonLen) + json + 0..3 填充
 *   [16..)    JSON 起始
 *   dataStart = 8 + u32@4 = 16 + align4(jsonLen)   ← 本版实测，勿用 16+headerSize
 *   [dataStart..) 文件数据区；条目 offset 相对 dataStart，以字符串存储
 *
 * 注意: 本版原始 asar 的文件数据是「紧挨着」写的（各文件 size 之和 == 数据区大小），
 * 不逐文件 4 字节对齐；本工具 pack 按任务要求逐文件 4 字节对齐（对齐量记入输出）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BLOCK_SIZE = 4194304; // 与 @electron/asar integrity 一致

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const align4 = (n) => (n + 3) & ~3;
const fmt = (n) => n.toLocaleString('en-US');
const mib = (n) => (n / 1048576).toFixed(2) + ' MiB';

export function readArchive(asarPath) {
  const buf = fs.readFileSync(asarPath);
  if (buf.length < 16) throw new Error('文件过小，不是 asar 归档');
  const headerBufLen = buf.readUInt32LE(4);
  const dataStart = 8 + headerBufLen;
  const jsonLen = buf.readUInt32LE(12);
  if (dataStart > buf.length) throw new Error(`header 长度越界: dataStart=${dataStart}, 文件=${buf.length}`);
  if (16 + jsonLen > dataStart) throw new Error('header JSON 越界');
  let header;
  try {
    header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
  } catch (err) {
    throw new Error(`header JSON 解析失败: ${err.message}`);
  }
  if (!header.files) throw new Error('header 缺少 files 字段');
  return { buf, header, dataStart, headerBufLen, jsonLen, dataLen: buf.length - dataStart };
}

/** 遍历条目: cb(relPath, entry, kind) kind = 'dir' | 'file' | 'link' */
export function walkTree(header, cb) {
  const walk = (node, prefix) => {
    for (const [name, e] of Object.entries(node)) {
      const rel = prefix ? prefix + '/' + name : name;
      if (e.files) { cb(rel, e, 'dir'); walk(e.files, rel); }
      else if (e.link !== undefined) cb(rel, e, 'link');
      else cb(rel, e, 'file');
    }
  };
  walk(header.files, '');
}

export function summarize(header) {
  const s = { files: 0, dirs: 0, links: 0, unpacked: 0, bytesAll: 0, bytesStored: 0, bytesUnpacked: 0 };
  walkTree(header, (rel, e, kind) => {
    if (kind === 'dir') { s.dirs++; return; }
    if (kind === 'link') { s.links++; return; }
    s.files++;
    s.bytesAll += e.size;
    if (e.unpacked) { s.unpacked++; s.bytesUnpacked += e.size; }
    else { s.bytesStored += e.size; }
  });
  return s;
}

function list(asarPath) {
  const t0 = Date.now();
  const { buf, header, dataStart, headerBufLen, jsonLen, dataLen } = readArchive(asarPath);
  const s = summarize(header);
  const pad = dataStart - (16 + jsonLen);

  console.log(`归档: ${asarPath}`);
  console.log(`文件大小: ${fmt(buf.length)} 字节 (${mib(buf.length)})`);
  console.log(`header: jsonLen=${fmt(jsonLen)} headerBuf=${fmt(headerBufLen)} dataStart=${fmt(dataStart)} 填充=${pad} 字节`);
  console.log(`条目: 文件 ${fmt(s.files)}（其中 unpacked ${fmt(s.unpacked)}）、目录 ${fmt(s.dirs)}、link ${fmt(s.links)}`);
  console.log(`数据区: ${fmt(dataLen)} 字节 (${mib(dataLen)})`);
  console.log(`条目尺寸合计: 内嵌 ${fmt(s.bytesStored)} 字节 (${mib(s.bytesStored)})；含 unpacked 全量 ${fmt(s.bytesAll)} 字节 (${mib(s.bytesAll)})`);
  if (dataLen !== s.bytesStored) console.log(`提示: 数据区与内嵌合计相差 ${fmt(Math.abs(dataLen - s.bytesStored))} 字节（对齐填充）`);

  console.log('顶层结构:');
  for (const [name, e] of Object.entries(header.files)) {
    if (e.files) {
      const sub = summarize({ files: { [name]: e } });
      console.log(`  ${name + '/'}  文件 ${fmt(sub.files)} 目录 ${fmt(sub.dirs)} 合计 ${mib(sub.bytesAll)}`);
    } else {
      console.log(`  ${name}  文件 ${fmt(e.size)} 字节`);
    }
  }
  console.log(`耗时 ${Date.now() - t0} ms`);
}

function extract(asarPath, outDir) {
  const t0 = Date.now();
  const { buf, header, dataStart } = readArchive(asarPath);
  const unpackedRoot = asarPath + '.unpacked';
  const unpackedExists = fs.existsSync(unpackedRoot);
  const st = { files: 0, dirs: 0, links: 0, unpackedCopied: 0, unpackedSkipped: 0, bytes: 0, linksSkipped: [] };

  fs.mkdirSync(outDir, { recursive: true });
  walkTree(header, (rel, e, kind) => {
    const dest = path.join(outDir, ...rel.split('/'));
    if (kind === 'dir') {
      fs.mkdirSync(dest, { recursive: true });
      st.dirs++;
      return;
    }
    if (kind === 'link') {
      st.links++;
      st.linksSkipped.push(rel);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (e.unpacked) {
      if (unpackedExists) {
        const src = path.join(unpackedRoot, ...rel.split('/'));
        if (fs.existsSync(src)) { fs.copyFileSync(src, dest); st.unpackedCopied++; st.bytes += e.size; return; }
      }
      st.unpackedSkipped++;
      return;
    }
    const off = Number(e.offset);
    if (!Number.isFinite(off) || off < 0 || dataStart + off + e.size > buf.length) {
      throw new Error(`条目越界: ${rel} offset=${e.offset} size=${e.size}`);
    }
    fs.writeFileSync(dest, buf.subarray(dataStart + off, dataStart + off + e.size));
    st.files++;
    st.bytes += e.size;
  });

  if (!unpackedExists) console.log(`注意: 未找到旁挂目录 ${unpackedRoot}，unpacked 条目仅计数、不落盘`);
  if (st.linksSkipped.length) console.log(`注意: link 条目 ${st.linksSkipped.length} 个未创建（本版无 link）`);
  console.log(`解包完成: ${outDir}`);
  console.log(`文件 ${fmt(st.files)} 目录 ${fmt(st.dirs)} unpacked 复制 ${fmt(st.unpackedCopied)} 跳过 ${fmt(st.unpackedSkipped)} 写入 ${fmt(st.bytes)} 字节 (${mib(st.bytes)})`);
  console.log(`耗时 ${Date.now() - t0} ms`);
}

export function integrityOf(data) {
  const blocks = [];
  for (let i = 0; i < data.length; i += BLOCK_SIZE) {
    blocks.push(sha256(data.subarray(i, Math.min(i + BLOCK_SIZE, data.length))));
  }
  return { algorithm: 'SHA256', hash: sha256(data), blockSize: BLOCK_SIZE, blocks };
}

function pack(srcDir, outAsar) {
  const t0 = Date.now();
  const root = fs.statSync(srcDir);
  if (!root.isDirectory()) throw new Error(`不是目录: ${srcDir}`);

  const headerTree = {};
  const files = []; // { rel, abs, size, node }
  const walk = (absDir, node, relPrefix) => {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, ent.name);
      const rel = relPrefix ? relPrefix + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        const child = {};
        node[ent.name] = { files: child };
        walk(abs, child, rel);
      } else if (ent.isFile()) {
        const size = fs.statSync(abs).size;
        const entry = { size, offset: null };
        node[ent.name] = entry;
        files.push({ rel, abs, size, entry });
      } else {
        throw new Error(`不支持的文件类型: ${abs}`);
      }
    }
  };
  walk(srcDir, headerTree, '');

  // 1) 分配 offset（dataStart 本身 4 字节对齐，故相对/绝对对齐等价）
  let cur = 0;
  for (const f of files) {
    f.entry.offset = String(cur);
    f.offset = cur;
    cur = align4(cur + f.size);
  }
  const dataSize = cur;

  // 2) 计算 integrity 后再写 header（先读一遍，流式写第二遍）
  for (const f of files) {
    f.entry.integrity = integrityOf(fs.readFileSync(f.abs));
  }

  const json = Buffer.from(JSON.stringify({ files: headerTree }), 'utf8');
  const jsonPad = (4 - (json.length % 4)) % 4;
  const payload = Buffer.alloc(4 + json.length + jsonPad);
  payload.writeUInt32LE(json.length, 0);
  json.copy(payload, 4);
  const headerBuf = Buffer.alloc(4 + payload.length);
  headerBuf.writeUInt32LE(payload.length, 0);
  payload.copy(headerBuf, 4);
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(4, 0);
  sizeBuf.writeUInt32LE(headerBuf.length, 4);

  fs.mkdirSync(path.dirname(outAsar), { recursive: true });
  const fd = fs.openSync(outAsar, 'w');
  try {
    fs.writeSync(fd, sizeBuf);
    fs.writeSync(fd, headerBuf);
    for (const f of files) {
      const data = fs.readFileSync(f.abs);
      fs.writeSync(fd, data);
      const pad = (4 - (data.length % 4)) % 4;
      if (pad) fs.writeSync(fd, Buffer.alloc(pad));
    }
  } finally {
    fs.closeSync(fd);
  }

  const total = fs.statSync(outAsar).size;
  console.log(`打包完成: ${outAsar}`);
  console.log(`文件 ${fmt(files.length)} 数据区 ${fmt(dataSize)} 字节 (${mib(dataSize)}) 归档 ${fmt(total)} 字节 (${mib(total)}) header ${fmt(headerBuf.length)} 字节`);
  console.log(`耗时 ${Date.now() - t0} ms`);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'list' && args.length === 1) list(args[0]);
    else if (cmd === 'extract' && args.length === 2) extract(args[0], args[1]);
    else if (cmd === 'pack' && args.length === 2) pack(args[0], args[1]);
    else {
      console.log('用法:');
      console.log('  node asar.mjs list <asar>');
      console.log('  node asar.mjs extract <asar> <outDir>');
      console.log('  node asar.mjs pack <dir> <outAsar>');
      process.exit(1);
    }
  } catch (err) {
    console.error(`失败: ${err.message}`);
    process.exit(1);
  }
}

// 仅在直接运行时执行 CLI；被 import 时只暴露函数（供 snapshot.mjs 复用）
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
