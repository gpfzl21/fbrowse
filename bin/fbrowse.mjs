#!/usr/bin/env node
import { main } from '../lib/cli.mjs';

process.umask(0o077);
try {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Node.js 22 이상이 필요합니다.');
  }
  await main(process.argv.slice(2));
} catch (error) {
  const messages = new Map([
    ['Root ID already exists', '이미 존재하는 루트 ID입니다.'],
    ['Unknown root ID', '존재하지 않는 루트 ID입니다.'],
    ['Root ID: 1–48 ASCII letters/digits/_/-, excluding project', '루트 ID는 영문·숫자·_·- 1~48자이며 project는 사용할 수 없습니다.'],
    ['Root name is required (max 120 characters)', '루트 이름이 필요합니다 (최대 120자).'],
    ['Invalid project root configuration', '프로젝트 루트 설정이 올바르지 않습니다.'],
    ['Invalid roots', '루트 설정이 올바르지 않습니다.'],
    ['Invalid root name', '루트 이름이 올바르지 않습니다.'],
    ['Root paths must be absolute', '루트 경로는 절대 경로여야 합니다.'],
    ['Timed out waiting for root configuration lock', '루트 설정 잠금 대기 시간이 초과되었습니다.'],
  ]);
  const message = messages.get(error.message) ?? (error.code === 'ENOENT' ? `경로가 없습니다: ${error.path ?? error.message}` :
    ['EACCES', 'EPERM'].includes(error.code) ? `접근 권한이 없습니다: ${error.path ?? error.message}` : error.message);
  console.error(`fbrowse: ${message}`);
  process.exitCode = 1;
}
