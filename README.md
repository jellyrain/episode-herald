<p align="center"><img src="resources/icon.png" alt="戴着报童帽的追更小报图标" width="88"></p>

# 追更小报 · Episode Herald

追更小报是一款 Windows 桌面应用。把想追的红果短剧加入清单，报童每天替你查看有没有新集或新季，有更新就发桌面通知。追更清单、设置和更新记录都保存在自己的电脑上。

[下载最新正式版](https://github.com/jellyrain/episode-herald/releases/latest) · [报告问题](https://github.com/jellyrain/episode-herald/issues) · [Apache 2.0 许可证](LICENSE)

## 下载与使用

Windows x64 有两种发行方式。请选择 **C 盘以外、当前用户可以写入的位置**，例如 `F:\Apps\episode-herald`。

| 版本 | 使用方式 | 软件更新 |
| --- | --- | --- |
| **免安装版**（`*-portable.zip`） | 完整解压，双击文件夹里的 `episode-herald.exe` | 后台下载新版 ZIP，在「软件设置 → 软件更新」点「重启并安装」 |
| **安装版**（`*-setup.exe`） | 运行安装向导，选择安装目录 | 后台下载新版，退出时安装，也可立即重启更新 |

打开「发现作品」，通过搜索、推荐、排行榜或分类筛选找到作品，加入「我的追更」。首次关注会记录已有分集，之后只提醒新增内容。你可以为单部作品暂停检查，或关闭关联新季追踪。

默认每天 **09:00** 检查。关闭窗口会收起到系统托盘，继续按时工作；完全退出后，下次启动会补查错过的任务。「更新记录」可查看哪部作品更新了、增加了几集。

## 本地数据与备份

两个发行版都在可执行文件旁创建 `data/`。其中包括追更数据库、封面、匿名设备档案、浏览器缓存、日志、临时文件和软件更新缓存。实际路径可在「软件设置」底部查看。

- **备份或换电脑**：从托盘完全退出，复制整个 `data/`。免安装版也可以连同整个程序文件夹一起移动。
- **从 v1.0.0 安装版升级**：首次启动新版时，如果新目录中没有数据库，会从旧版用户目录导入追更记录、设置、匿名档案和封面。确认迁移成功后，可自行清理旧目录。
- **从旧版切换到免安装版**：先退出旧版，将旧数据目录中的 `hongguo.sqlite` 及同名的 `-wal`、`-shm` 文件（如有）、`anonymous.json` 和 `covers/` 复制到免安装目录下的 `data/`，再启动应用。

## 本地开发

项目基于 Electron、React 和 TypeScript，使用 pnpm 管理依赖，通过 [openhongguo](https://github.com/beilunyang/openhongguo) 匿名读取作品及分集信息。红果接口发生变化时，发现或检查功能可能暂时不可用。

```powershell
git clone https://github.com/jellyrain/episode-herald.git
cd episode-herald
fnm use --install-if-missing
pnpm install --frozen-lockfile
pnpm dev
```

开发数据位于工程内的 `.local-data/`，Electron 和打包工具的下载缓存位于 `.build-cache/`。在 Windows 上使用 `pnpm test` 运行离线测试，`pnpm build` 检查类型并编译，`pnpm run build:win` 在 `dist/` 生成安装包、免安装 ZIP 和更新清单。
