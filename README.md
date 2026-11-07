<p align="center"><img src="resources/icon.png" alt="戴着报童帽的追更小报图标" width="88"></p>

# 追更小报 · Episode Herald

追更小报是一款 Windows 桌面应用。把想追的红果短剧加入清单，报童每天替你查看有没有新集或新季，通过桌面通知或 QQ 机器人提醒你。追更清单、设置和更新记录都保存在自己的电脑上。

[下载最新正式版](https://github.com/jellyrain/episode-herald/releases/latest) · [报告问题](https://github.com/jellyrain/episode-herald/issues) · [MIT 许可证](LICENSE)

> **使用前请阅读[免责声明](#免责声明)。** 追更小报是独立开发的第三方工具。通过本应用访问红果接口仅供个人学习和研究，请勿用于商业服务或大规模采集。

## 下载与使用

Windows x64 有两种发行方式。请选择 **C 盘以外、当前用户可以写入的位置**，例如 `F:\Apps\episode-herald`。

| 版本 | 使用方式 | 软件更新 |
| --- | --- | --- |
| **免安装版**（`*-portable.zip`） | 完整解压，双击文件夹里的 `episode-herald.exe` | 后台下载新版 ZIP，在「软件设置 → 软件更新」点「重启并安装」 |
| **安装版**（`*-setup.exe`） | 运行安装向导，选择安装目录 | 后台下载新版，退出时安装，也可立即重启更新 |

打开「发现作品」，通过搜索、推荐、排行榜或分类筛选找到作品，加入「我的追更」。首次关注会记录已有分集，之后只提醒新增内容。你可以为单部作品暂停检查，或关闭关联新季追踪。

默认每天 **09:00** 检查。关闭窗口会收起到系统托盘，继续按时工作；完全退出后，下次启动会补查错过的任务。「更新记录」可查看哪部作品更新了、增加了几集。

在「我的追更」点击 **可预约**，可以只看已识别到预约季的作品，数字按作品计数。

## 推送

侧栏的「推送」按渠道分别配置。Windows 桌面通知和 QQ 机器人可以独立开启。

使用 QQ 时，在已登录的 OneBot v11 机器人（如 SnowLuma）开启 HTTP 服务。打开「推送 → QQ 机器人」，填写从这台电脑能访问的 HTTP 服务地址、该服务的 Access Token（如已设置），选择私聊或群聊并填写接收 QQ 号或群号。开启通道并保存后，可以先点「测试连接」确认机器人账号，再点「发送测试消息」验证接收端。[OneBot v11 发送接口](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)

开启通道后发现的新季或新集会自动发送，最近 50 条发送记录可在 QQ 标签内查看。机器人明确拒绝的消息可以手动重试；连接中断且收不到回执时显示「待核实」，请以 QQ 聊天记录为准。Token 在本机加密保存，换电脑或 Windows 账户后可能需要重新输入。

## 本地数据与备份

两个发行版都在可执行文件旁创建 `data/`。其中包括追更数据库、封面、匿名设备档案、浏览器缓存、日志、临时文件和软件更新缓存。实际路径可在「软件设置」底部查看。

- **备份或换电脑**：从托盘完全退出，复制整个 `data/`。免安装版也可以连同整个程序文件夹一起移动。`data/covers/` 保存已缓存的封面，换机后可离线显示。尚未缓存或已清理的封面需要联网重新获取。
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

## 免责声明

追更小报通过非官方 SDK openhongguo 查询作品目录和分集信息，用于追踪新季、新集。使用红果接口时，请遵守适用法律及平台使用规则。请勿利用本应用批量采集平台数据、对外提供收费查询服务，或从事侵犯他人权益的活动。参见 [openhongguo 的完整免责声明](https://github.com/beilunyang/openhongguo#免责声明)。

作品、封面和简介等内容的权利归各自权利人所有。查看或缓存这些内容不代表获得转载、再分发或商业使用的授权。

更新提醒依赖平台返回的数据，可能因接口变更或网络故障而延迟或遗漏。具体上线时间请以红果平台为准。使用者应对自己的接口访问及内容使用行为负责。

## 许可证

追更小报的原创代码采用 [MIT 许可证](LICENSE)。随项目分发的第三方组件适用各自的许可证，相关署名见 [NOTICE](NOTICE)。
