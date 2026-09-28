# madobe（窓辺）

ブラウザで動く「天気と時間帯の生きたシーン」の棚。Three.js で描いた環境映像を切り替えて眺める、作業用の背景映像（BGV）アプリです。

- 音はありません。映像と「シーンの増やしやすさ」に集中しています
- 各シーンは固定映像ではなく、雨量・風・日の高さなどをスライダーで動かせます
- ビルド不要。Three.js を CDN から読むだけの静的サイトです（スマホ対応）

## 動かす

`file://` で直接開くとスクリプトを読めない場合があるので、静的サーバーを使ってください。

```sh
npx serve .
# または
python3 -m http.server 8000
```

ブラウザで `http://localhost:3000`（serve）または `http://localhost:8000` を開きます。

### GitHub Pages で公開する

`main` にプッシュすると GitHub Actions（`.github/workflows/pages.yml`）が自動で GitHub Pages にデプロイします。

初回だけ、リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にしてください。
有効化する前に走ったワークフローは「Create Pages site failed」で失敗するので、有効化したあとに
**Actions → Deploy to GitHub Pages → Re-run all jobs** を押すか、次のプッシュを待ちます。

公開 URL は `https://<ユーザー名>.github.io/madobe/` です。

### アプリとしてインストールする（PWA）

公開 URL（https）または `localhost` で開くと、PWA としてインストールできます。

- **Android / PC の Chrome・Edge**：右下パネルの「インストール」ボタン、またはアドレスバーのインストールアイコン
- **iOS / iPadOS の Safari**：共有メニュー →「ホーム画面に追加」（iOS には `beforeinstallprompt` がないのでボタンは出ません）

インストール後は全画面（`display: fullscreen`）で起動し、ホーム画面のショートカットから各シーンを直接開けます。
`sw.js` がアプリ本体と three.js・フォントをキャッシュするので、2回目以降はオフラインでも動きます。
ファイルを増やしたら `sw.js` の `APP_FILES` に足し、中身を変えたら `VERSION` を上げてください（古いキャッシュを捨てるため）。

## 操作

| 操作 | 内容 |
| --- | --- |
| 上部のタブ | シーン切替。URL ハッシュ（`#night-rain`）で直リンクできます |
| 右下のスライダー | シーンごとのパラメータ |
| UIを隠す | 上下の UI をフェードアウト。画面タップ / `Esc` で戻ります |
| 全画面 | `requestFullscreen`（iOS Safari では効きません） |
| インストール | PWA としてホーム画面 / デスクトップに追加（ブラウザが対応しているときだけ表示） |
| キーボード | `h` UI 表示切替、`f` 全画面、`←` `→` シーン切替 |

## シーン

| id | 名前 | パラメータ |
| --- | --- | --- |
| `night-rain` | 街灯の夜雨 | 雨量 / 風 / 落下速度 |
| `dusk-rain` | 夕暮れの雨 | 日の高さ / 雨量 / 風 |
| `campfire` | 焚き火 | 火の勢い / 風 / 火の粉 / 煙 |

雨の2シーンは路肩の草が「風」に合わせて揺れます。焚き火は炎・火の粉・煙が同じ「風」でなびきます。

## シーンを追加する

1. `src/scenes/` にファイルを1つ置く
2. `index.html` の `<script>` 一覧に1行足す

これだけです。各シーンファイルはグローバルの `madobe.register()` を1回呼びます。

```js
madobe.register({
  id: 'night-rain',              // URL ハッシュに使う。英小文字とハイフン
  name: '街灯の夜雨',            // 画面左下のタイトル
  meta: 'rain · night',          // タイトル下の小さなキャプション
  params: [                      // ここからスライダーを自動生成
    { key: 'count', label: '雨量', min: 200, max: 3000, step: 100, value: 1800 },
    { key: 'wind',  label: '風',   min: -6,  max: 6,    step: 0.5, value: 1.5 },
  ],
  create(ctx) {
    // ctx = { THREE, renderer, scene, camera, params, reduceMotion, helpers }
    // scene にオブジェクトを追加し、camera を配置する
    return {
      update(dt, t, params) {},   // 毎フレーム。dt は秒（0.05 でクランプ済み）、t は経過秒
      render(renderer, scene, camera) {}, // 描画を自前でやる場合（省略可。ポストエフェクト用）
      onParam(key, value) {},     // スライダー変更時（省略可）
      dispose() {},               // 自前で作った RenderTarget などの解放（省略可）
    };
  },
});
```

### アプリ側がやること

- `THREE.WebGLRenderer` は1つだけ作り、全シーンで共有する
- シーン切替時は旧 `scene` を traverse して geometry / material / texture を dispose する
- `renderer.shadowMap.enabled`・`toneMapping`・`toneMappingExposure` はシーンごとにリセットする（シーン側が `create` 内で設定してよい）
- `render` フックがあるシーンはそれを呼び、なければ `renderer.render(scene, camera)` を呼ぶ
- `resize` で `renderer.setSize` と `camera.aspect` を更新する
- `prefers-reduced-motion` のときはカメラの揺れを止める（`ctx.reduceMotion` で渡す）

### 共通ヘルパー（`ctx.helpers`）

- `makeRain(THREE, scene, { max, area, color, opacity })` → `{ mesh, update(dt, { count, wind, speed }, onLand) }`
  雨粒は `LineSegments`。1粒＝2頂点で、落下方向ベクトルに沿って線分を伸ばします。着地時に `onLand(x, z)` を呼び、上端で再生成します
- `makeRipples(THREE, scene, { count, color, maxOpacity, speed })` → `{ spawn(x, z), update(dt) }`
  `RingGeometry` のプールを再利用して地面の波紋を広げます
- `makeGrass(THREE, scene, { count, place(i) → [x, z], clusters, height, blades, bladeWidth, spread, color, roughness })` → `{ mesh, update(dt, t, { wind, sway }) }`
  風に揺れる草むら。3枚の葉を交差させた株を `InstancedMesh` で並べ（1ドローコール）、頂点シェーダーで根元を固定したまま先端を曲げます。`wind` はシーンの風パラメータと同じ単位、`sway` は揺れの強さ（0 で静止）
- `makeFlame(THREE, scene, { layers, width, height, bright, position, camera, embers: { max }, smoke: { max, tint, opacity } })` → `{ group, flicker, update(dt, t, { power, wind, embers, smoke, pixelHeight }) }`
  ゆらゆら揺れる炎。細長い板を `layers` 枚、少しずつ角度をずらして重ね、常にカメラの方へ向けます。形と色はフラグメントシェーダーで作ります：3D シンプレックスノイズを上向きに流し、ドメインワープで輪郭を巻き込ませ、温度に応じた黒体放射風の色（暗赤→橙→黄→白）を付けます（テクスチャ不要・加算合成・HDR）。`power` は火の勢い（1 が基準）、`wind` で先端がなびきます。`embers` で根元から舞い上がる火の粉、`smoke` で先端から立ちのぼる煙（`Points`）が付き、`update` で表示数を変えられます。`flicker.value`（約 0.8〜1.2）を光源の強さに掛けると、光が炎と同じ拍で明滅します
- `makePost(THREE, renderer, { bloom, threshold, vignette })` → `{ render(scene, camera, { time, haze, bloom, exposure }), dispose(), hdr }`
  ポストエフェクト。HDR のレンダーターゲット（WebGL2 なら半精度浮動小数・MSAA）にシーンを描き、1/4 解像度のブルーム（発光の滲み）と陽炎（`haze = { x, y, width, height, strength }` で指定した範囲の空気の歪み）を掛け、ACES トーンマッピングと sRGB 変換をして画面に出します。使うシーンは `create` で `renderer.toneMapping = THREE.NoToneMapping` にし（アプリ側が切替時に戻します）、`render` フックから `post.render` を呼び、`dispose` で `post.dispose()` を呼びます

## ファイル構成

```
madobe/
├─ index.html            シェル。タブ・タイトル・パネル・スクリプト読み込み
├─ manifest.webmanifest  PWA のマニフェスト（名前・アイコン・表示モード・ショートカット）
├─ sw.js                 Service Worker（アプリ本体と CDN のキャッシュ）
├─ icons/                PWA のアイコン（icon.svg が元。PNG は 192 / 512 / maskable / apple-touch）
├─ src/app.js            レンダラ、シーン切替、UI自動生成、共通ヘルパー、PWA の登録
├─ src/scenes/
│  ├─ night-rain.js      街灯の夜雨
│  ├─ dusk-rain.js       夕暮れの雨
│  └─ campfire.js        焚き火
├─ .github/workflows/pages.yml   GitHub Pages への自動デプロイ
└─ README.md
```

## 技術メモ

- Three.js r128 の UMD ビルド（cdnjs）。グローバル `THREE` を使います。ES Modules 版へ移行するときは `importmap` を使い、バンドラは入れません
- `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` で高 DPI 端末の負荷を抑えています
- 雨粒は最大 3000。それ以上はシェーダー化（InstancedBufferGeometry）を検討します
- 1シーンあたりの `update` は 60fps が目標。スマホで重いシーンは `params` の初期値を下げます
- フォントは見出しが Shippori Mincho、数値・ラベルが IBM Plex Mono（Google Fonts）。フォールバック指定あり

## ロードマップ（優先度順）

1. 雨以外のシーンを1つ追加して「天気全般」の棚にする（雪、霧、晴れの夕焼けのどれか）
2. シーン切替時のクロスフェード
3. 時間帯の自動進行モード（現在時刻でシーンと日の高さを変える）
4. 雨粒のシェーダー化（GPU 側で動かし、数万粒でも軽くする）
5. 地面に `Reflector` で本物の映り込み
6. 音（外部サービスへのリンクか、ユーザーが選んだ音源の再生のみ。自作しない）

v0 で作らないもの：音、アカウント、設定の保存・共有、シーンエディタ、作業タイマー
