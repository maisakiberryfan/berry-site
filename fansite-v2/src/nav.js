// 導覽列資料（結構與三語 label 沿用現站 fansite/assets/data/nav.json）
//
// - internal: 由 SPA router 接手的站內路徑
// - external: 開新分頁的外部連結
// 三語欄位維持 label / labelEn / labelJa 慣例，取值用 i18n.svelte.js 的 pickLabel()。

export const brand = {
  label: '苺咲べりぃ非公式倉庫',
  labelEn: 'Maisaki Berry Unofficial Archive',
  labelJa: '苺咲べりぃ非公式倉庫',
  href: '/',
}

/** 桌面版：下拉分組 */
export const groups = [
  {
    label: '草莓的',
    labelEn: "Berry's",
    labelJa: 'べりぃの',
    items: [
      { label: '個人資料', labelEn: 'Profile', labelJa: 'プロフィール', href: '/profile' },
      { label: '歷史', labelEn: 'History', labelJa: '沿革', href: '/history' },
      { label: '服裝', labelEn: 'Clothes', labelJa: '衣装', href: '/clothes' },
      { label: '音樂作品', labelEn: 'Discography', labelJa: 'ディスコグラフィ', href: '/discography' },
    ],
  },
  {
    label: '列表',
    labelEn: 'List',
    labelJa: 'リスト',
    items: [
      { label: '歌曲列表', labelEn: 'Song List', labelJa: '楽曲リスト', href: '/songlist' },
      { label: '直播列表', labelEn: 'Stream List', labelJa: '配信リスト', href: '/streamlist' },
      { label: '歌單', labelEn: 'Set List', labelJa: 'セットリスト', href: '/setlist' },
      { label: '別名', labelEn: 'Aliases', labelJa: 'エイリアス', href: '/aliases' },
      { divider: true },
      { label: '分析', labelEn: 'Analytics', labelJa: '分析', href: '/analytics' },
    ],
  },
  {
    label: '其他 Wiki',
    labelEn: 'Other Wiki',
    labelJa: '他のWiki',
    items: [
      { label: 'seesaawiki', href: 'https://seesaawiki.jp/maisakiberry/', external: true },
      { label: 'HackMD', href: 'https://hackmd.io/@MaisakiBerry', external: true },
      {
        label: 'Fandom',
        href: 'https://virtualyoutuber.fandom.com/wiki/Maisaki_Berry',
        external: true,
      },
    ],
  },
  {
    // 粉絲自營的 Discord 社群（非本站／官方營運）——「粉絲 Discord」避免被誤認為官方伺服器
    label: '粉絲 Discord',
    labelEn: 'Fan Discord',
    labelJa: 'ファンDiscord',
    icon: 'discord',
    items: [
      { label: '中文', labelEn: 'Chinese', labelJa: '中国語', href: 'https://discord.gg/sXdaXB7', external: true },
      { label: 'English', href: 'https://discord.gg/csQ77FEyTA', external: true },
    ],
  },
]

/** 右上外部連結：只放 berry 本人的官方渠道（icon-only，同現站；label 作 tooltip/aria） */
export const externalLinks = [
  // 官方網站帶文字（icon-only 看不出「官方」語意）；X/YouTube icon 本身即品牌識別
  { label: '官方', labelEn: 'Official', labelJa: '公式', href: 'https://www.maisakiberry.com/', icon: 'official', showLabel: true },
  { label: 'X', href: 'https://twitter.com/MaisakiBerry', icon: 'x' },
  { label: 'YouTube', href: 'https://www.youtube.com/channel/UC7A7bGRVdIwo93nqnA3x-OQ', icon: 'youtube', iconColor: '#ff0000' },
]

/** 本站自己的連結（非官方渠道，放頁尾不放右上） */
export const siteLinks = [
  { label: 'GitHub', href: 'https://github.com/maisakiberryfan/berry-site', icon: 'github' },
]
