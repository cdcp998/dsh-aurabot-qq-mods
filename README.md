# dsh-aurabot-qq-mods

Aurabot 插件（[dsh-aurabot-qq](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)）的**模块市场**：面板「模块市场」里能装的模块都在这里。

- 想用模块：在 Aurabot 面板打开「模块市场」，点安装。插件 1.2.0 起支持。
- 想看有哪些：[模块目录](modules/README.md)。
- 想写一个：[提交教程](docs/TUTORIAL.md)。

```
modules/<id>/         模块，一个模块一个文件夹，不按分类分层
modules/README.md     模块目录，按分类排列，自动生成
pet-pack/             桌宠默认素材包
docs/TUTORIAL.md      第一次提交模块的教程
docs/MODULE_SPEC.md   模块格式、分类、发布流程和索引格式
scripts/              校验、打包、生成索引
revoked.json          撤回的模块版本
```

- 想提交模块：看 [贡献指南](CONTRIBUTING.md)。
- 模块经审核合并后，CI 自动打包发布到 Releases，索引在 `registry` 分支的 `index.json`。

## 独立模块仓库

以下模块同时在作者个人账号下有独立仓库，用于开发记录和问题反馈；模块源仍以本仓库 `modules/<id>/` 为准，发布和校验流程不变。

| 模块 | 独立仓库 |
|---|---|
| 讨饭 | [cdcp998/beg-for-money](https://github.com/cdcp998/beg-for-money) |
| 印象卡片 | [cdcp998/impression-card](https://github.com/cdcp998/impression-card) |
| 价格监控 | [cdcp998/price-watch](https://github.com/cdcp998/price-watch) |

## 许可范围

本仓库内容的许可各不相同：

| 内容 | 许可 |
|---|---|
| `pet-pack/` | CC BY-NC-SA 4.0，见根目录 [LICENSE](LICENSE) 和下面的「署名与许可」 |
| `modules/<id>/` | 各模块文件夹里自己的 `LICENSE` |
| `scripts/`、`test/`、`docs/`、`.github/` 和仓库说明文档 | MIT，见 [scripts/LICENSE](scripts/LICENSE) |

## 桌宠素材

「Aurabot 桌宠」模块用的形象与动画素材。插件在启动时发现默认素材包缺失，
会自动从本仓库下载 zip 并落位到本地数据目录，用户无需手动操作。

## 目录结构

```
pet-pack/
├── default-config.json          # 形象包配置（动画池、权重、物理参数）
├── default-manifest.json        # 动画名 ↔ 文件编号对照表
└── default-animation/
    ├── anim-001.webm
    ├── anim-002.webm
    └── ...                      # 共 106 个 webm（VP9 + alpha，约 640×360）
```

- 素材必须放在**文件夹里**（如 `pet-pack/`），不要摊在仓库根目录。
- 插件按「哪一层里有 `default-animation/`」来定位包根，所以文件夹名可改（`pet-pack/`、`default/` 等均可），
  但 `default-config.json`、`default-manifest.json`、`default-animation/` 三者必须同级。
- 换了目录名或改了下载地址后，在插件面板「桌宠 → 素材包下载地址」填本仓库的 archive 直链即可：
  `https://github.com/accomplish07zrh-eng/dsh-aurabot-qq-mods/archive/refs/heads/main.zip`
  （国内网络可换成 Gitee 等镜像直链；也可调 `POST /packs/fetch-default` 手动重下。）

## 署名与许可

- 形象与动画素材来源：**dsh-pet** 的 pet pack（作者 **PC2005-cloud**）。
- 许可：**CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享）
  <https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans>
- 作者声明原文：「大肥鱼是遵守 CC BY-NC-SA 4.0 协议的形象，不可以以任何形式商业化。」

因此：

- **可以**在署名、非商业、相同方式共享的前提下分发与修改（含本仓库、含随插件自动下载）。
- **不可以**任何形式的商业化使用（含付费打包、付费分发、商业产品内置）。
- 再分发（含镜像本仓库）必须保留上述署名与本许可声明，并以相同许可共享。

完整许可条款见 [LICENSE](LICENSE)。插件侧的第三方声明见上游仓库的
[THIRD-PARTY-NOTICES.md](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/main/THIRD-PARTY-NOTICES.md)。

## 说明

- 本仓库采用「素材不进插件 git」的方式分发：素材体积约 53MB，放独立仓库可避免撑大插件仓库与 PR。
- 素材文件为二进制 `.webm`，已在 `.gitattributes` 中标记为 binary，避免跨平台换行或 diff 噪音。
