# vendor/ —— 可选的离线数据文件

这里放 **ip2region 的 IPv4 xdb 数据文件**，用于顶栏显示访问 IP 的**省 / 市**。

- **不放也能跑**：顶栏只显示 IP，后端启动日志会打印「IP 归属地：未加载」。缺文件不影响任何功能。
- 认两个文件名：`ip2region_v4.xdb`（官方现在的名字）或 `ip2region.xdb`（老名字），放在本目录即可；
  也可用环境变量 `IP2REGION_XDB=/绝对路径` 指到别处（此时只认那一个路径）。
- **只要 IPv4 那个**：`ip2region_v6.xdb` 本工具不支持（解析按 IPv4 段写的）。

## 从哪来

官方仓库 lionsoul2014/ip2region 的 `data/` 目录。**注意文件名已改为 `ip2region_v4.xdb`**，旧的 `ip2region.xdb` 现在返回 404。

- 下载页：https://github.com/lionsoul2014/ip2region/blob/master/data/ip2region_v4.xdb
- 直链：https://raw.githubusercontent.com/lionsoul2014/ip2region/master/data/ip2region_v4.xdb
- 国内镜像：https://gitee.com/lionsoul/ip2region → `data/ip2region_v4.xdb`

方式一，浏览器：打开上面的下载页 → 点右上 **Download raw file** → 存到本目录，文件名保持 `ip2region_v4.xdb`。

方式二，命令行：

```bash
curl -L -o ip2region_v4.xdb \
  https://raw.githubusercontent.com/lionsoul2014/ip2region/master/data/ip2region_v4.xdb
```

> 别把 `ipv4_source.txt` 直接扔进来——那是原始文本，不是 xdb 二进制。

## 放好后怎么确认

```bash
node lib/geo.js 114.114.114.114
# 期望：打印出 { country/province/city/isp ... }，而不是「未能加载数据文件」或「未命中」
```

再重启服务，顶栏 IP 后面应出现「省 市」。启动日志会变成「IP 归属地：已加载 …/vendor/ip2region_v4.xdb」。

## 注意

- **不进 git**（见 `.gitignore` 的 `vendor/*.xdb`）：十几 MB 的二进制，走备份/拷贝，别进版本库。
- **只能定位到"出口 IP 的大致位置"**：内网地址无归属地；办公网 NAT 后同一 IP；移动/宽带常落在运营商节点城市。**不是人的位置**。
- 解析失败一律**不显示**（宁可空，也不显示错城市）。
