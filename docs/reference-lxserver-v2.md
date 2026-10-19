# lxserver 参考评估

评估对象为 [XCQ0607/lxserver v2.0.0](https://github.com/XCQ0607/lxserver/releases/tag/v2.0.0)（发布于 2026-07-22，提交 `d0ee845ef8f98f46f72ac79546581a025041605f`）和 [v2.0.1](https://github.com/XCQ0607/lxserver/releases/tag/v2.0.1)（提交 `5c220b978ac1864d0a367930e579f009dfe7f933`）。本文只记录可验证的设计取舍；LX-Sync 未复制该项目代码。

截至 2026-10-20，上游最新正式版为 [v2.1.3](https://github.com/XCQ0607/lxserver/releases/tag/v2.1.3)，发布于 2026-10-12。v2.0.2 至 v2.1.3 的同步相关增量主要是网页登录后自动连接本地同步、歌单同步下载和本地歌曲状态联动，依赖 lxserver 自带播放器、下载任务与用户登录凭据，不适用于 LX-Sync 当前的同步服务边界。

上游 main 另有尚未随正式版发布的 [4d98fbc](https://github.com/XCQ0607/lxserver/commit/4d98fbc8a6c53c6152676896416f7e83e3712fb8) 黑名单同步修复。该提交为 lxserver fork 的结构化规则对象增加兼容处理，并将覆写数据转回字符串下发；官方 [LX Music 桌面客户端规则类型](https://github.com/lyswhut/lx-music-desktop/blob/master/src/common/types/dislike_list.d.ts)仍为字符串。LX-Sync 当前按字符串处理该 wire 字段，与官方客户端契约一致，不移植 fork 内部对象格式。

## 本轮采用的管理端交互

- 分页：参考 `v2.0.1` 的[页码输入与首页、末页边界处理](https://github.com/XCQ0607/lxserver/blob/5c220b978ac1864d0a367930e579f009dfe7f933/public/music/js/batch_pagination.js#L306-L345)，为当前歌单增加首页、末页和整数页码跳转，展示总页数，并拒绝越界页码。LX-Sync 继续使用指定快照下的服务端分页，保留当前筛选条件。
- 单歌单导出：参考 `v2.0.1` 的[完整歌单 JSON 导出](https://github.com/XCQ0607/lxserver/blob/5c220b978ac1864d0a367930e579f009dfe7f933/public/music/app.js#L9784-L9828)。LX-Sync 从指定不可变快照导出一个完整歌单，不受页面筛选和分页影响，采用自有 `format: "lx-sync.playlist"`、`version: 1` 归档格式；不声明为 LX 原生或通用导入格式，也不替代完整数据库备份。
- 复制反馈：上游 `v2.0.0` 已有[歌曲包含标记](https://github.com/XCQ0607/lxserver/blob/d0ee845ef8f98f46f72ac79546581a025041605f/public/music/app.js#L10787-L10795)和[全重复提示](https://github.com/XCQ0607/lxserver/blob/d0ee845ef8f98f46f72ac79546581a025041605f/public/music/app.js#L10989-L10999)；`v2.0.1` 新增 [ensurePlaylistDataAvailable](https://github.com/XCQ0607/lxserver/blob/5c220b978ac1864d0a367930e579f009dfe7f933/public/music/app.js#L11786-L11809)，在打开添加弹窗前检查并按需补取歌单数据。LX-Sync 采用服务端只读复制预检查，按带类型的歌曲 ID 展示预计新增、已存在数量；正式复制在用户级串行任务与 CAS 约束下重新计算，并反馈实际新增和跳过数量，预检查不推进快照或设备基线。

## 采用的思路

- 添加歌曲前必须同时具备受支持的 `source` 和平台歌曲 ID，拒绝 `unknown`、`local`、文件名回退值等伪标识。
- 列表搜索使用分页，并把来源、歌手、专辑作为显式筛选条件；普通关键词仍用于当前歌单内的多字段包含搜索。
- 远程备份需要可配置周期、保留策略和恢复入口，且上传失败不能被当作成功。

歌曲管理和筛选已按 LX-Sync 的边界重新实现：管理写入仍经过 PostgreSQL head 行锁/CAS、事务审计和在线广播，搜索仍绑定指定的不可变快照。远程备份目前只形成 PostgreSQL 一致性 dump、独立 `MASTER_KEY` 托管和隔离恢复演练的运维设计；仓库没有内置定时上传或自动恢复服务，实际可恢复性必须由目标环境演练证明。

## 不采用的实现

- 不引入 Web 播放器、下载/洗版、本地音乐索引、音质探测、Subsonic、公共曲库或第三方音乐平台抓取。
- 不使用文件目录作为业务事实源，也不把 WebDAV zip 直接解压覆盖运行目录。该方式不能替代 PostgreSQL 一致性 dump，且缺少本项目所需的独立密钥托管、客户端加密、强校验和隔离恢复门禁。
- 不保存管理凭据到 LocalStorage，不新增 query token 或跨域鉴权模式。
- 不采用“始终选择最新备份并自动恢复”的策略；生产恢复必须由操作者确认不可变备份 ID、镜像 digest 和密钥版本。
- 高级布尔搜索语法继续后置。当前优先提供可组合的显式字段筛选，避免在没有稳定语法契约、错误位置和兼容测试前扩大查询语言。

## 搜索范围结论

本阶段搜索范围保持为 URL 中明确指定的单个歌单。原因是管理端的批量移动、复制和移除都需要唯一来源歌单及其 `expectedSnapshotId`；把不同歌单的结果混入同一个可选择表格会让写入归属和冲突恢复变得含糊。

如果后续需要跨歌单搜索，应新增只读聚合资源，并在每条结果中返回 `playlistId`、歌单类型、原始位置和 snapshot ID；跨歌单批量写要另行设计原子性与部分失败语义，不能复用当前单歌单 mutation。
