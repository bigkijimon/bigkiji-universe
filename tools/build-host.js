'use strict';

const { spawnSync } = require('child_process');

// macOSの配布ビルド（dist:mac）は Developer ID Application 証明書＋公証が前提。
// 証明書が無いマシンでは electron-builder が forceCodeSigning で失敗するだけなので、
// その場合はローカル自己署名ビルド（dist:local）へ自動で切り替える。
// Developer IDを取得した時点で、何も書き換えずに配布ビルドへ戻る。
function macTarget() {
  const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const hasDeveloperId = /Developer ID Application/.test(identities.stdout || '');
  if (hasDeveloperId) return 'dist:mac';
  console.log('[build-host] Developer ID Application 証明書が無いためローカル自己署名ビルド（dist:local）で実行します。');
  console.log('[build-host] 配布用DMG/公証が必要な場合は Apple Developer Program の証明書を導入してください。');
  return 'dist:local';
}

const target = process.platform === 'darwin' ? macTarget()
  : process.platform === 'win32' ? 'dist:win' : 'dist:linux';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', target], { stdio: 'inherit', shell: false });
process.exit(result.status == null ? 1 : result.status);
