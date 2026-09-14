/* xlsx 导出器测试：node test/xlsx.test.mjs
 * 生成文件后调用 python3 + openpyxl 回读校验（真实校验 zip 结构与单元格内容）
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import '../src/xlsx.js';

const { build } = globalThis.IC.xlsx;
let pass = 0,
  fail = 0;
const eq = (a, e, label) => {
  if (JSON.stringify(a) === JSON.stringify(e)) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}  期望 ${JSON.stringify(e)}，实际 ${JSON.stringify(a)}`);
  }
};

const sheets = [
  {
    name: '未扫到',
    widths: [40, 20, 10],
    rows: [
      ['商品名称', '串号', '在库'],
      ['智能手机/华为/Mate 70 & "Pro" <测试>', '5FV0225A30002656', 1],
      ['平板电脑/华为/MatePad Mini', '860521070176858', 2],
      ['含中文标点，逗号；分号', 'ABC-123', 0],
    ],
  },
  { name: '表外串号', rows: [['码', '归属', '次数'], ['999000111222333', '别家门店库', 1]] },
  { name: '汇总', rows: [['项目', '数量'], ['应盘', 409], ['已盘', 2], ['未盘', 407]] },
];

const bytes = build(sheets);
console.log(`  xlsx 体积：${bytes.length} 字节`);
// ZIP 头校验
eq([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'ZIP 头正确');

fs.mkdirSync('test/tmp', { recursive: true });
fs.writeFileSync('test/tmp/out.xlsx', bytes);

// 用 python zipfile 校验 CRC（zipfile 会校验每个条目的 CRC32）
const py = `
import zipfile, sys, json
z = zipfile.ZipFile('test/tmp/out.xlsx')
bad = z.testzip()
print("ZIP_CRC_BAD:", bad)
print("ENTRIES:", json.dumps(sorted(z.namelist()), ensure_ascii=False))
import openpyxl
wb = openpyxl.load_workbook('test/tmp/out.xlsx')
print("SHEETS:", json.dumps(wb.sheetnames, ensure_ascii=False))
ws = wb['未扫到']
print("ROWSCOLS:", json.dumps([ws.max_row, ws.max_column]))
vals = [[c.value for c in row] for row in ws.iter_rows()]
print("VALUES:", json.dumps(vals, ensure_ascii=False))
ws2 = wb['汇总']
print("SUMMARY:", json.dumps([[c.value for c in r] for r in ws2.iter_rows()], ensure_ascii=False))
`;
const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const lines = Object.fromEntries(
  out
    .trim()
    .split('\n')
    .map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i), l.slice(i + 1).trim()];
    })
);
eq(lines.ZIP_CRC_BAD, 'None', 'ZIP 无 CRC 错误（结构合法）');
eq(JSON.parse(lines.SHEETS), ['未扫到', '表外串号', '汇总'], '三个工作表可读');
eq(JSON.parse(lines.ROWSCOLS), [4, 3], '行列数正确');
eq(JSON.parse(lines.VALUES)[1][0], '智能手机/华为/Mate 70 & "Pro" <测试>', '含 XML 特殊字符的文本未损坏');
eq(JSON.parse(lines.VALUES)[1][2], 1, '数字列存为数字');
eq(JSON.parse(lines.SUMMARY).length, 4, '汇总表 4 行');

console.log(`\nxlsx 测试：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
