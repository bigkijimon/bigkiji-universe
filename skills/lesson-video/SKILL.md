---
name: lesson-video
description: UPCLASS / H&S の英語教材ページと教材動画を作るときの正本。既存カリキュラムと既存キャラクターの所在、RolePlayBook の版面、画像→動画の型、実測所要時間。トリガー: 教材, カリキュラム, RolePlayBook, UPCLASS, ユニット, 教材動画, 場面画, タイキャンプ。
---

# 教材ページと教材動画

**着手前にこの2つを必ず確認する。どちらも一度事故を起こしている。**

1. 作ろうとしている文型が**既存教材と重複していないか**
2. 使おうとしているキャラクターが**もう存在していないか**

---

## 1. 既存カリキュラム — 新しいユニットを立てる前に必ず突き合わせる

2026-08-07、`RolePlayBook #2` だけを見て「At the Night Market / How much is it? / I'd like ~,
please」を立案した。**既存の u03 と u07 の 100% の重複**で、着手直前に気づいて廃案にした。
`content/materials/thailand.ts` を見ていなかったことが原因。

### 正本の所在

| 何 | どこ |
|---|---|
| タイ教材 8ユニット | `English_School/HSAcademyWeb/content/materials/thailand.ts`（1168行） |
| ユニットの画像 | `HSAcademyWeb/public/images/materials/thailand/<uNN-slug>/scene.png` |
| ユニットの音声 | `HSAcademyWeb/public/audio/materials/thailand/<uNN-slug>/*.mp3` |
| RolePlayBook #1/#2 | `Creative_Media/VideoStudioJustin/教材メディア/PeEh/RolePlayBook #N.pdf` |
| その他の教材PDF | 同 `教材メディア/`（2.1GB・講師別） |

### タイ教材で既に教えている文型（2026-08-11 時点・**9本**）

| | ユニット | 目標文型 |
|---|---|---|
| u01 | Off to Thailand! | `I have a ___.` |
| u02 | Time Travel in Ayutthaya | `This is a ___.` / `What is she doing?` |
| u03 | What Would You Like?（屋台でちゅうもん） | `I would like ___, please.` |
| u04 | Can You Dance? | `I can ___, but I can't ___.` |
| u05 | Wild Elephants! | `There is ___. / There are ___.` |
| u06 | How's the Weather? | `It's ___ today.` |
| u07 | How Much Is It?（LOTUSでおかいもの） | `How much is it? — It's ___ baht.` |
| u08 | Thank You, Thailand! | `I like ___ the best.` |
| **u09** | **Where is the night market?**（よるのいちばへ みちを たずねる） | **`Where is the ___?` / `Go straight and turn ___.`** |

### ★ 巻は2冊ある（2026-08-11 に分かった重要な食い違い）

**Thailand編は RolePlayBook #2 の「版面の型」だけを借りて中身を全部差し替えた別物**だった。
原本の10ユニットは1本もデジタル化されていなかったので、**別の巻として立てた**。

| 巻 | URL | 中身 |
|---|---|---|
| Thailand | `/play/materials/thailand` | タイ旅行に翻案したもの・9本（u09が動画/地図つき） |
| **Role Play Book** | `/play/materials/roleplay` | **原本そのもの**・10本（u01 完成、u02〜u10 は じゅんび中） |
| Daily Routine One | `/play/textbook` | 別の本（旧い仕組み・触らない） |

**Role Play Book（原本）の10ユニットと目標文型**:

| | ユニット | 目標文型 | フォニックス |
|---|---|---|---|
| u01 | I like and I want | `I like to ___.` | Pp Dd |
| u02 | It is my favorite! | `This is my favorite ___.` | Ff Ee |
| u03 | I want to Challenge! My Goals | `I want to challenge ___.` | 原本に無し |
| u04 | I can jump but I can't fly | `I can ___, but I can't ___.` | Rr Ll |
| u05 | My town | `That is ___. / Those are ___.` | Tt Mm |
| u06 | My family | `I have a ___.` | Gg Ss |
| u07〜u10 | 絵を見て答える4本 | 現在進行形の絵描写 | 原本に無し |

> **原本の複製に重複チェックは当てはめない。**
> u04 は Thailand編 u04 と、u06 は Thailand編 u01 と文型が一致するが、
> **重なりは Thailand編がこの原本から借りた結果**。原本側は原本に忠実にする。
> 重複チェックは「**新しい**文型を立てるとき」の規律。

> **原本にフォニックスが無い回**（u03 と u07〜u10）は、巻の中で未使用の2文字を補い、
> `teacherNote` に「原本に無く、器の都合で補った」と必ず書く（器は「ちょうど2文字」を要求する）。

### 重複の確かめ方（語ではなく構造で見る）

```bash
# 2026-08-11 修正: CEOBigKiji は 2026-08-09 に解体済み。この道はもう無い
cd ~/Documents/School/HSAcademyWeb/content/materials
grep -oE 'frame:\s*"[^"]+"' thailand.ts        # 既存の文型を全部出す
for W in "next to" "turn right" "Where is"; do grep -ci "$W" thailand.ts; done
pdftotext -layout ".../RolePlayBook #2.pdf" - | grep -ci "$W"
```

**機能語の一致は重複ではない。** `It's next to the ___.` は `It's ___ today.` と `It's` を共有
するが、教えているのは場所の前置詞であって天気ではない。**教える構造そのものが既存に0件か**を見る。

---

## 2. 既存キャラクター — 新規に起こす前に必ず探す

2026-08-07、`.glb` `.fbx` だけを探して「3Dキャラクターは1体も無い」と報告した。**誤りだった。**
実体は**レンダリング済みPNG**で、`.glb` は全部「なつやすみ」ゲームの小物225点だった。

| 場所 | 中身 | 解像度 |
|---|---|---|
| `Creative_Media/VideoStudioJustin/教材メディア/テキストブック/` | **Kiji（トラ猫マスコット）**・Satomi・Mami・Seruzi・Marble・PeEh・Yuma・Hime・Mona・Michi = 14点 | Kiji **3072²**・他 1024²〜 |
| `English_School/hajimete-cinema-demo/assets/teachers3d/` | 講師11名バストアップ | 640² |
| `HSAcademyWeb/public/images/characters/` | kiji・maria・satomi・mami（＋face版） | 各種 |

**画調**: Pixar / Disney 調の3Dレンダー・白背景・全身。Kiji は両手を広げた立ち姿＝ポーズ変換の素。
**新規キャラを足すときの手順は `hajimete-cinema-demo/BRIEF.md` が正本**
（ip-adapter-faceid-plusv2 で顔一貫 ＋ realcartoon-xl-v4 or Flux+PuLID・正方形バストアップ）。
`models/pulid/pulid_flux_v0.9.1.safetensors` と `models/insightface/buffalo_1` は導入済み。
**採用前に既存キャラと並べて画調が揃うか目視する**（BRIEF.md の品質ゲート）。

**主人公は Kiji を優先する**（オーナー方針・2026-08-07）。動物なので I2V で顔が崩れても目立たず、
実在の講師を子ども役にしないで済む。

### 屋台・町の背景に使える既存GLB（`ComfyUI/output` の225点から）

`festival_stall` `paper_lantern` `lantern_toro` `shichirin` `shop_awning` `lightbox_sign`
`sode_kanban` `scooter_cub` `wooden_stool` `street_lamp` `handcart` `produce_crate`
`basket_kago` `electric_fan` `nabe_pot` `corn_grilled`
——**日本の祭り屋台なのでタイ寄せの加工は要る。**

---

## 3. RolePlayBook の版面（#2 から実測）

**A3横 1190.25 × 842.25 pt・1ユニット1ページ。** 白地。上端に水彩のにじみ帯。

```
[UNIT<n> シアン丸バッジ]  タイトル（ティール太字）
┌─ 左段 ────────────────┐ ┌─ 右段 ────────────────┐
│ ① Vocabulary          │ │ ③ Interview a friend  │
│   文型（空欄つき）      │ │   場面画＋吹き出し     │
│   語彙タイル 4×2       │ │   置換表（淡黄・赤ピン） │
│ ② listen and read      │ │ ④ And what else?      │
│   （フォニックス）      │ │   手描き枠＋点線罫     │
└───────────────────────┘ └───────────────────────┘
HAPPY & SMILE · UPCLASS                    RolePlayBook — UNIT n
```

**色**: ティール `#24b3c6` / 見出し `#1a94a5` / 黄緑バナー `#c3d64c` / 黄下線 `#ffe94d` /
淡黄の置換表 `#fdf6c9`。**フォントは丸ゴシック**——`Arial Rounded MT Bold` を先に置く
（`Hiragino Maru Gothic ProN` はラテン字形を持たず素のサンセリフに落ちる）。

**高学年向けは `listen and read` を外してよい**（オーナー確定・2026-08-07）。空いた枠は
そのユニットの言語が実際に使われる場面に充てる（U09 は地図）。

### 組版は HTML → Chrome → PDF

```sh
chrome --headless=new --no-pdf-header-footer --print-to-pdf=out.pdf file://.../spread.html &
# Chrome は PDF を書いたあと終了しない。ファイルができるまでポーリングして kill する。
```
`@page { size: A3 landscape; margin: 0 }` ＋ `html,body { width:420mm; height:297mm }`。
`pdfinfo` で **1ページ**・**1191×842pt** を確認する（2ページになったら溢れている）。

**地図・アイコン・図はSVGで描く。生成させない。** Flux は看板に読めない疑似文字を必ず入れる
（2026-08-07 実測、`no text` を指定しても入った）。教材に読めない文字は載せられない。

### 作ったら必ず突き合わせる

**地図と対話文と書く練習の答えが一致しているか。** 一度ずれた（「turn right at the temple」で
地図上の夜市に着かない／出発点の隣にある学校を「まっすぐ→左折」で探させていた）。
**目視で「それっぽい」で通さず、地図の上で実際に指をたどる。**

---

## 4. 画像 → 動画

### 画像（Flux）

`ComfyUI/user/default/workflows/English_School/10_Flux1Dev_教材場面画_2pass.api.json` が正本。
Flux1-dev Q6_K ＋ 2パス Hires fix ＋ 4x-UltraSharp。**単発 KSampler 一発出しは禁止**（部署規律）。

> **⚠️ API形式のJSONに数字以外のキーを残さない。** このワークフローには `_readme` という
> 説明キーがあり、`/prompt` に投げると ComfyUI 0.30.2 が **`node_errors` すら返さない素の
> HTTP 500** で落ちる。原因が全く見えないので30分溶かした。投げる前に
> `{k:v for k,v in wf.items() if k.isdigit()}` で漉す。

**動く絵にするための構図**（I2V は画面に写っているものしか動かせない）:
前景＝主役／中景＝湯気・手の動き／後景＝連なる灯り・歩く人・スクーター。暖色と寒色を対比させる。
**カットごとに最低3層が動く状態**にしておく。

**実測（M1 Max 64GB / MPS / 2026-08-07）**: 1344×768・2パス・4x-UltraSharp で **1249秒（20.8分）**、
最低空きメモリ 6.3 GB。

### ⚠️ 物語を作る前に — Flux はキャラクターを固定できない

2026-08-07 実測。**キャラクターの記述を一字一句同じにし、種も規則的に振っても、連続する2カットで
別の猫が出た**（目が青→黒、縞のズボン→素足、黄色いカメラ→茶色の鞄、絵画調→フラット調）。
27カット作れば27匹出る。**物語の動画は、これを解いてから着手する。**

この Mac に入っている固定手段:

| 道具 | 使えるか |
|---|---|
| `models/ipadapter/ip-adapter-plus_sdxl_vit-h` | **SDXL専用。Flux には付かない** |
| `models/ipadapter/ip-adapter-faceid-plusv2_sdxl` | 同上。かつ**人間の顔検出**が前提で動物に効かない |
| `models/pulid/pulid_flux_v0.9.1` | Flux 用だが insightface 依存＝**人間の顔のみ** |
| Flux Redux (`style_models/`) | **未導入** |
| `models/unet/qwen-image-edit-2511-Q4_K_S.gguf` | **導入済み。参照画像から編集できる本命** |

**解き方（推奨）**

1. **1枚だけ**、本物のキャラクター（`教材メディア/テキストブック/`）を場面に置いた絵を作る
   —— Qwen-Image-Edit か、SDXL+IPAdapter で作って Flux で仕上げる
2. そこから先は **H3 のフレーム連結**（前のクリップの最終フレームを次の `first_frame` に渡す）。
   絵そのものを引き継ぐので**原理的にズレない**。幕の変わり目だけ描き直して補正する
3. 副産物として **Flux の回数が27回→3回**に減る（9.4時間 → 1時間）

**カットごとに Flux を回すのは、時間が3倍かかるうえに物語が壊れる。** 両方の理由で採らない。

**実測**: Flux 2パス 1344×768 のキーフレームは **1263秒・1243秒（各21分）**。

### 動画（MiniMax H3）

起動手順・GGUF経路・モデル配置は `~/.claude/skills/minimax-h3-video/SKILL.md` が正本。ここには書かない。

**公式の構造化プロンプトを崩さない**（1行目の指示文＋空行＋3フィールド）。

> **`non_diegetic_music` は必ず「none」と書く。**
> ここに何か書くと **BGM がクリップの音声に焼き込まれ、後から差し替えられなくなる**。
> BGM は全クリップが揃ってから ACE-Step で別に作って ffmpeg で合成する（オーナー方針）。
> `overall_soundscape` の現場音（鉄板・雑踏・スクーター）は焼き込んでよい。

> **ACE-Step のサーバを動画生成中に立てない。**
> `gpu-signal.sh` の `gen_running()` が `pgrep -f acestep-api` を含むため、**サーバ自身が
> 「生成中」に永久ヒット**して acquire が30分スピンする（`music-gen` に記録済み）。
> 順番を守るのが回避策で、「BGMは後から」というオーナー方針とちょうど一致する。

### 所要時間 — 見積もりは外挿ではなく実測で出す

3分の動画を頼まれたら、まずこの表を見せる。H3 は1本最長5秒程度（`length` は 17k+5 グリッド）
なので、**3分＝35本以上を繋ぐ**ことになる。

| 解像度 / フレーム / ステップ | 実測 | 最低空きメモリ | 出た尺 |
|---|---|---|---|
| 768×432 / 39f / 8步 | **510秒** | — | 1.625秒 |
| **1344×768 / 39f / 25步** | **5694秒（94.9分）· 228 s/it** | **3.1 GB（スワップ無し）** | 1.625秒 |
| 1344×768 / 124f / 25步 | **6時間29分**（973 s/it） | **0.1 GB＝スワップ** | 採らない |

**空きメモリを毎回記録する。** 数GBを切ってなお下がり続けるならスワップで、その設定は捨てる
（1344×768/124f が 0.1 GB・973 s/it）。**ただし空きが安定していれば、遅さは純粋な計算時間で、
メモリを空けても縮まない**——1344×768/39f/25步 は終始 3.1 GB 以上を保ったまま95分かかった。
効くのは解像度・フレーム数・ステップ数だけで、**量子化を軽くしても効かない**
（MPS では fp16 に展開される）。

### 3分を頼まれたときに出す数字

| 設定 | 動画1秒あたり | **3分の所要** |
|---|---|---|
| 768×432 / 8步 | 314秒 | **16時間** |
| 1344×768 / 25步 | **3504秒** | **175時間（7.3日）** |

**11.2倍。** H3 は1本5秒程度が上限なので3分は35〜111本の接続になり、この時間は連続GPU占有
＝その間 Mac は他の仕事ができない。**尺と画質は同じ時間予算を取り合う。**
着手前に必ずこの表を見せて決めてもらう。

**クリップは1本ずつ独立に保存する。** 途中で止まっても最初からにしない。

### 字幕

**焼き込まない。** MP4 の字幕トラック（`mov_text`／tx3g）として入れて切り替えられるようにする。

```sh
ffmpeg -i video.mp4 -i subs.srt -c copy -c:s mov_text -metadata:s:s:0 language=eng out.mp4
```
`.srt` も同じフォルダに置く。**iPhone で字幕ボタンが出るかは実機でしか確認できない**ので、
焼き込み版も併置して「ファイルを選べば切り替わる」形にしておく。

---

## 5. 成果物の置き場

完成品は `BKU-Check/deliverables/<日付>-<slug>/` へ（`bku-check` スキルの決めごと）。
**本番ツリー（`HSAcademyWeb/content` `public/`）には勝手に書かない。** Vercel の本番に出る。
サイトに載せるかはオーナーが実物を見てから決める。

**読み取りはローカルで。** `pdftotext` / `pdftoppm` / `sips`、必要なら `qwen2.5vl:7b`。
課金モデルにページ画像を渡さない。ただし**ローカル vision は Ollama を使うので、動画生成中には
走らせない**——読み取りは全部先に済ませる。

---

## 6. 「次のページ作って」と言われたら（2026-08-11 に道を1本に通した）

オーナーは**言った瞬間に動き出すこと**を求めている。迷わないよう、手順をここに固定する。
すべて `~/Documents/School/HSAcademyWeb` で実行する。

| # | やること | コマンド |
|---|---|---|
| 1 | 指定を1ブロック足す | `scripts/materials/specs/units.json` に no/key/template/title/ja/emoji/target/phonics/scene/vocabTheme/aRole/bRole（地図つきなら `"map": true`） |
| 2 | 下書きを作る（**ローカル・課金0**） | `bash scripts/materials/run-pipeline.sh --volume roleplay <key>` |
| 3 | レビューして取り込む | `out/<key>.final.json` を読んで `content/materials/thailand.ts` に手で入れる |
| 4 | 音声を作る | `PATH="/opt/anaconda3/bin:$PATH" bash scripts/materials/30-audio.sh` |
| 5 | 動画（要るときだけ） | Media側で作って `public/video/materials/thailand/<key>/` へ |
| 6 | 検証して出す | 下の3点 |

**`run-pipeline.sh` は引数でユニットを絞れる**（2026-08-11 追加）。
無指定だと specs のぜんぶを回して**既存を作り直しGPUを何時間も食う**ので、1本のときは必ずキーを渡す。
存在しないキーを渡すと**何もせず終了コード2で止まる**（打ち間違いで0本回るのを防ぐため）。

ローカル出力は**無検査で本番に入れない**。3段（草稿 qwen3.5:35b → 批評 gemma4 → 改稿 qwen3.6）
を通しても、最後は人が読んでから `thailand.ts` に入れる。

### 動画つきユニットの作り（u09 が最初の1本）

```
public/video/materials/thailand/<key>/
  lesson.mp4     通し（授業のはじめに1回見る）
  <tile>.mp4 ×5  トピックの頭で見る短いカット
```

型は `content/materials/types.ts` の `UnitVideos`。スロットは6つ ——
`lesson` / `target` / `words` / `askA` / `askB` / `produce`。
**すべて任意**なので、動画を持たない u01〜u08 は1行も変えずに済む。

- **字幕は焼かない**（小さく表示すると読めない・紙面と二重になる）。
  そのぶん `caption`（英文）と `ja` が**必須**。`assertUnit()` が空だと落とす
- `sec` は実測値を入れる（読み込み前に枠を確保して紙面が跳ねないように）
- `members: true` を付けると**ログイン案内カードに差し替わる**。
  ⚠️ **これは目隠しであって鍵ではない。** `public/` のファイルはURLを直接叩けば取れる。
  本当の鍵は「LIFFを新設（環境変数が要る）」か「生徒アプリ側へ移す」のどちらかで、別案件
- **授業で投影する短いタイルには `members` を付けない**（付けると授業が止まる）

### 地図タスク

`MapTask` は Template A/B のどちらにも足せる**任意ブロック**（テンプレートを増やさない）。
図は画像ではなく**コンポーネント内の SVG**（拡大しても崩れない・札を1つずつ押せる・画像を増やさない）。
設問は `PictureQuestion` を使い回すが、**`count` は使えない**（画像台帳が無く検算できないので
`assertUnit()` が落とす）。設問音声は `map-q-N.mp3`（`30-audio.sh` が作る）。

### PDF

`app/(print)/worksheet/<巻>/<key>` が印刷用ページ。
`node --experimental-strip-types scripts/materials/98-pdf.mjs` で
`public/pdf/materials/thailand/<key>.pdf` に出す（`puppeteer-core` は導入済み・**先に3100番でサーバを上げる**）。
ユニット一覧は**データから読む**ので、ユニットが増えても勝手に追随する
（かつての 97-printcheck は8本を手で書いていて9本目が黙って漏れていた。2026-08-11 に 98 へ統合して削除）。

### 検証の3点（目視で決めない）

```bash
node --experimental-strip-types scripts/materials/95-verify.mjs   # 終了コード0
npx next build --webpack                                          # turbopack は必ず落ちる
python3 ~/Documents/Media/VideoStudioJustin/scripts/audio-lang-check.py \
        public/video/materials/thailand/<key>                      # 全部 en であること
```

`next build` に **`--webpack` を付ける**。turbopack は `next/font/google` の内部モジュール解決に
失敗して**必ず**落ちる。

### H3で動画を作るときの罠（2026-08-11 実測・オーナー指摘で発覚）

1. **台詞を1文字も書かなくても H3 は喋る。** 実験4本をそのまま納品したら、言語判定は
   ポルトガル語/ウクライナ語/ポーランド語/ロシア語だった。**納品前に必ず言語を機械で見る**
2. **H3の生音は 32000Hz、edge-tts に差し替えた音は 48000Hz。** `ffprobe` 一発で見分けられる
3. **口の動きは英語と合わない。** H3は自分が作った音に口を合わせるので、
   英語を後乗せすると吹き替えのズレが残る → **口元に寄るカットを作らない**
4. **カメラは生成ではなく後処理で足す。** H3は「中身の正しさ」と「カメラの動き」を同時に出せない
   （終端を自由にすると中身が崩れる）。H3の寄りは実測でほぼ平面のズーム（手前/奥 1.03）だったので、
   ffmpeg の切り出し拡大で同じものが正確・単調・数秒で得られる

### サンドボックス（Pi で作業するとき）

`~/Documents/School/.pi/sandbox.json` の `allowRead` に
`/Users/yuma/Documents/Media/VideoStudioJustin/成果物` を通してある（2026-08-11 追加）。
これが無いとグローバルの `denyRead: ["/Users"]` に当たって**動画を読めず作業が止まる**。
`allowWrite` は**空のまま**（taskRoot を cwd に絞る この部署の設計を壊さない）。

### §5 の「本番ツリーに勝手に書かない」について

原則は変わらない。ただし **2026-08-11 の u09 はオーナーの明示的な承認のもとで
`content/` と `public/` に直接入れた**。承認があるときだけ本番ツリーに書く。
