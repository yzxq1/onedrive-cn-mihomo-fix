// 焊进"会重建规则数组"的 JS 覆写时用。
//
// 如果你的覆写脚本里有类似：
//     config.rules = [ ... ];
// 那么独立 override 的 +rules 可能在订阅更新后被它整体覆盖。
// 解决：把下面这段，粘进 config.rules 数组里，放在
//     "GEOSITE,onedrive,..."  和  "DOMAIN-KEYWORD,onedrive,..."  之前。
// 规则按顺序匹配，排在前面才会先命中。
//
// 记得把 "🚀 节点选择" 换成你自己的节点/代理组名。

    // —— OneDrive 混合分流修复 ——
    //   控制面 onedrive.live.com / api.onedrive.com 被 GFW 域名级 SNI 阻断，
    //   任何微软直连 IP 的 TLS 握手都会被重置 → 必须走节点（流量仅几 KB）。
    //   数据面（大文件）直连实测可用 → 强制 DIRECT，不烧节点流量。
    "DOMAIN-SUFFIX,onedrive.live.com,🚀 节点选择",
    "DOMAIN,api.onedrive.com,🚀 节点选择",
    "DOMAIN-SUFFIX,microsoftpersonalcontent.com,DIRECT",
    "DOMAIN-SUFFIX,files.1drv.com,DIRECT",
    "DOMAIN-SUFFIX,up.1drv.com,DIRECT",
    "DOMAIN-SUFFIX,storage.live.com,DIRECT",
    "DOMAIN-SUFFIX,livefilestore.com,DIRECT",
