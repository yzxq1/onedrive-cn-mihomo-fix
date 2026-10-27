# OneDrive 国内同步慢/卡死修复（mihomo / Clash 混合分流）

国内用 OneDrive（尤其个人版）同步极慢、卡死、CPU 空转，但把 OneDrive 整体丢给代理又烧机场流量？

这个仓库记录了一次完整的**诊断 → 定位根因 → 混合分流修复**的全过程，并给出可直接复用的 mihomo / Clash 覆写（override）规则。

> 环境：macOS + mihomo-party（Clash Party）。规则对任何 mihomo / Clash.Meta 内核通用。

---

## TL;DR

OneDrive 慢的真因**不是分流规则配错**，而是：

1. **`onedrive.live.com` 被 GFW 域名级 SNI 阻断** —— 换任何一个微软真实 IP 直连，TCP 都能连上，但 TLS 握手一律被重置（`HTTP 000`）。光靠 hosts 优选 IP 救不回来。
2. **叠加 DNS 污染** —— `onedrive.live.com` 被解析到一个 Facebook 的 IPv6（`2a03:2880:…:face:b00c`，`face:b00c` 是 Facebook 的标志地址）和一个超时的垃圾 IP。开了 `dns.ipv6: true` 时，内核先试那个假 v6 → `no route to host`，再试坏 v4 → `i/o timeout`，于是同步卡死、客户端 CPU 空转重试。

**解法 = 混合分流（控制面走节点 / 数据面直连）：**

| 流量 | 域名 | 走向 | 原因 |
|---|---|---|---|
| 控制面（鉴权/文件列表元数据，**几 KB**） | `onedrive.live.com`、`api.onedrive.com` | **走节点** | 直连被 SNI 阻断 |
| 数据面（大文件，**几十 GB**） | `*.files.1drv.com`、`*.up.1drv.com`、`microsoftpersonalcontent.com`、`storage.live.com`、`livefilestore.com` | **直连 DIRECT** | 直连实测可用，不烧节点流量 |

控制面走节点后，DNS 由节点远程解析，**污染问题也一并消失**，不需要再配 hosts。

---

## 诊断过程（可复现）

### 1. 确认流量确实走了直连，规则没配错

查内核日志，OneDrive 流量正确命中 `GeoSite(onedrive)` → 直连：

```
[TCP] ... --> xxx.sharepoint.com:443   match GeoSite(onedrive) using 📂 OneDrive[DIRECT]
[TCP] ... --> api.onedrive.com:443     match GeoSite(onedrive) using 📂 OneDrive[DIRECT]
```

### 2. 抓到真正失败的那条

```
dial 📂 OneDrive (match GeoSite/onedrive) --> onedrive.live.com:443 error:
  dial tcp [2a03:2880:f10c:283:face:b00c:0:25de]:443: connect: no route to host
  dial tcp 107.181.166.244:443: i/o timeout
```

`onedrive.live.com` 根本不该解析到 Facebook 的地址段 —— 典型 DNS 污染 + 坏 IP。

### 3. 用干净 DoH 重新解析，拿到真实微软 IP

```bash
for d in onedrive.live.com skyapi.onedrive.live.com api.onedrive.com storage.live.com; do
  curl -s -H 'accept: application/dns-json' \
    "https://1.1.1.1/dns-query?name=$d&type=A" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('$d', ' '.join(a['data'] for a in d.get('Answer',[]) if a['type']==1))"
done
```

| 域名 | 真实 IP（干净解析） |
|---|---|
| `onedrive.live.com` | `13.107.137.11` / `13.107.139.11` |
| `skyapi.onedrive.live.com` / `api.onedrive.com` | `150.171.22.11` |
| `storage.live.com` | `168.62.7.82` |

### 4. 关键一步：逐 IP 实测直连 TLS 握手（绕过代理）

```bash
# 换任何微软 IP，onedrive.live.com 直连 TLS 都失败 → 是"域名级 SNI 阻断"，不是 IP 问题
for ip in 13.107.137.11 13.107.139.11 150.171.22.11; do
  curl -s -o /dev/null --noproxy '*' --max-time 7 \
    -w "$ip  TLS:%{time_appconnect}s HTTP:%{http_code}\n" \
    --resolve onedrive.live.com:443:$ip https://onedrive.live.com/
done
```

实测结论：

| 域名 | 直连 TLS | 处置 |
|---|---|---|
| `onedrive.live.com`（含 `skyapi.*`） | ❌ 每个 IP 都 TLS 重置（`HTTP 000`） | **走节点** |
| `api.onedrive.com` | ❌ 偶发重置 | **走节点** |
| `login.live.com` / `login.microsoftonline.com` / `account.live.com` | ✅ `200/302` | 直连 OK |
| `my.files.1drv.com` | ✅ `400` | **直连** |
| `my.microsoftpersonalcontent.com`（新版个人存储） | ✅ `401` | **直连** |
| `storage.live.com` / `d.docs.live.net` | ✅ | **直连** |

> `HTTP 400/401/403` 不是失败，代表**已连到微软服务器**（只是匿名/裸请求被拒）；`HTTP 000` 才是连不上（TLS 被重置或超时）。

---

## 落地方式

### 方式 A：独立 override（订阅里**不重建**规则数组时用）

把 [`overrides/onedrive-hybrid.yaml`](overrides/onedrive-hybrid.yaml) 作为一个覆写加载，`+rules` 会前置到内置规则之前。

```yaml
+rules:
  - DOMAIN-SUFFIX,onedrive.live.com,🚀 节点选择   # 含 skyapi.*
  - DOMAIN,api.onedrive.com,🚀 节点选择
  - DOMAIN-SUFFIX,microsoftpersonalcontent.com,DIRECT
  - DOMAIN-SUFFIX,files.1drv.com,DIRECT
  - DOMAIN-SUFFIX,up.1drv.com,DIRECT
  - DOMAIN-SUFFIX,storage.live.com,DIRECT
  - DOMAIN-SUFFIX,livefilestore.com,DIRECT
```

把 `🚀 节点选择` 换成你自己的节点/代理组名。

### 方式 B：焊进会重建规则的 JS 覆写（推荐）

⚠️ **坑**：如果你的覆写脚本里有 `config.rules = [ ... ]`（整体重建规则数组），那么方式 A 的 `+rules` 可能在订阅更新后**被它冲掉**。这时要把规则直接写进那个脚本，放在 `GEOSITE,onedrive` **之前**。见 [`overrides/rules-snippet.js`](overrides/rules-snippet.js)。

---

## 验证修复是否生效

```bash
# 经你的代理端口访问，现在应返回 403/302（已连上），不再是 000
curl -s -o /dev/null -x http://127.0.0.1:7890 --max-time 20 \
  -w 'TLS:%{time_appconnect}s HTTP:%{http_code}\n' https://onedrive.live.com/
```

内核日志里应能看到它改走节点：

```
[TCP] ... --> onedrive.live.com:443  match DomainSuffix(onedrive.live.com) using 🚀 节点选择[<你的节点>]
```

然后重启一次 OneDrive 客户端（`killall OneDrive && open -a OneDrive`，macOS），让它用新路由重连。**重启不会丢文件**，本地文件在磁盘上，未完成的传输会断点续传。

---

## 原理小结

- **SNI 阻断 vs DNS 污染**：两者都针对 `onedrive.live.com`。DNS 污染可以用 hosts/干净 DoH 绕过，但 **SNI 阻断发生在 TLS 握手阶段**，固定再好的 IP 也会被重置——只能让连接从境外节点发起。
- **为什么不整体走代理**：个人版 OneDrive 大文件走 `*.files.1drv.com` / `microsoftpersonalcontent.com`，动辄几十 GB，全走机场会烧爆流量且受限于节点小水管；而这些域名直连实测可用，所以保持 DIRECT。
- **只有控制面需要节点**：鉴权、文件列表、增量元数据这些域名流量极小（几 KB/次），走节点成本可忽略，却是打通同步的关键。

---

## 参考

- 社区同类思路：本地反代（Watt Toolkit）、规则分流（Loyalsoldier / blackmatrix7）、Hosts 测速选优（OnedriveHostsGenerator / UsbEAm）。本方案属于"规则分流"派，并补充了"SNI 阻断"这一关键诊断——这是纯 hosts 方案解决不了的部分。

---

*诊断与文档整理：2026-10-27。规则里的 IP 为当次干净解析结果，可能随微软 Anycast 调整而变化，以你本地实测为准。*
