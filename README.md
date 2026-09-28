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

## 操作

| 操作 | 内容 |
| --- | --- |
| 上部のタブ | シーン切替。URL ハッシュ（`#night-rain`）で直リンクできます |
| 右下のスライダー | シーンごとのパラメータ |
| UIを隠す | 上下の UI をフェードアウト。画面タップ / `Esc` で戻ります |
| 全画面 | `requestFullscreen`（iOS Safari では効きません） |
| キーボード | `h` UI 表示切替、`f` 全画面、`←` `→` シーン切替 |

## シーン

| id | 名前 | パラメータ |
| --- | --- | --- |
| `night-rain` | 街灯の夜雨 | 雨量 / 風 / 落下速度 |
| `dusk-rain` | 夕暮れの雨 | 日の高さ / 雨量 / 風 |
| `campfire` | 焚き火 | 火の勢い / 風 / 火の粉 |

どのシーンも草が「風」に合わせて揺れます。焚き火の炎と火の粉も同じ「風」でなびきます。

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
      onParam(key, value) {},     // スライダー変更時（省略可）
      dispose() {},               // 自前で作った RenderTarget などの解放（省略可）
    };
  },
});
```

### アプリ側がやること

- `THREE.WebGLRenderer` は1つだけ作り、全シーンで共有する
- シーン切替時は旧 `scene` を traverse して geometry / material / texture を dispose する
- `renderer.shadowMap.enabled` と `toneMappingExposure` はシーンごとにリセットする（シーン側が `create` 内で設定してよい）
- `resize` で `renderer.setSize` と `camera.aspect` を更新する
- `prefers-reduced-motion` のときはカメラの揺れを止める（`ctx.reduceMotion` で渡す）

### 共通ヘルパー（`ctx.helpers`）

- `makeRain(THREE, scene, { max, area, color, opacity })` → `{ mesh, update(dt, { count, wind, speed }, onLand) }`
  雨粒は `LineSegments`。1粒＝2頂点で、落下方向ベクトルに沿って線分を伸ばします。着地時に `onLand(x, z)` を呼び、上端で再生成します
- `makeRipples(THREE, scene, { count, color, maxOpacity, speed })` → `{ spawn(x, z), update(dt) }`
  `RingGeometry` のプールを再利用して地面の波紋を広げます
- `makeGrass(THREE, scene, { count, place(i) → [x, z], clusters, height, blades, bladeWidth, spread, color, roughness })` → `{ mesh, update(dt, t, { wind, sway }) }`
  風に揺れる草むら。3枚の葉を交差させた株を `InstancedMesh` で並べ（1ドローコール）、頂点シェーダーで根元を固定したまま先端を曲げます。`wind` はシーンの風パラメータと同じ単位、`sway` は揺れの強さ（0 で静止）
- `makeFlame(THREE, scene, { layers, width, height, position, camera, colors, embers: { max } })` → `{ group, flicker, update(dt, t, { power, wind, embers }) }`
  ゆらゆら揺れる炎。細長い板を `layers` 枚交差させて常にカメラの方へ向け、フラグメントシェーダーの fbm ノイズで輪郭と色を作ります（テクスチャ不要・加算合成）。`power` は火の勢い（1 が基準）、`wind` で先端がなびきます。`embers` を渡すと根元から火の粉（`Points`）が舞い上がり、`update` の `embers` で表示数を変えられます。`flicker.value`（約 0.8〜1.2）を光源の強さに掛けると、光が炎と同じ拍で明滅します

## ファイル構成

```
madobe/
├─ index.html            シェル。タブ・タイトル・パネル・スクリプト読み込み
├─ src/app.js            レンダラ、シーン切替、UI自動生成、共通ヘルパー
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

v0 で作らないもの：音、アカウント、設定の保存・共有、シーンエディタ、作業タイマー、PWA/オフライン
