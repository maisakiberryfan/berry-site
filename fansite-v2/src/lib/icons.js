// navbar/footer 用的 bootstrap-icons（開源 MIT，與現站同一套圖庫）
// ?raw import 於 build 期 inline，無 runtime 依賴；fill="currentColor" 跟隨文字色
import houseFill from 'bootstrap-icons/icons/house-fill.svg?raw'
import twitterX from 'bootstrap-icons/icons/twitter-x.svg?raw'
import youtube from 'bootstrap-icons/icons/youtube.svg?raw'
import github from 'bootstrap-icons/icons/github.svg?raw'
import discord from 'bootstrap-icons/icons/discord.svg?raw'

const sized = (svg, px) =>
  svg.replace('width="16" height="16"', `width="${px}" height="${px}"`)

export const icons = {
  official: sized(houseFill, 18),
  x: sized(twitterX, 18),
  youtube: sized(youtube, 20),
  github: sized(github, 18),
  discord: sized(discord, 18),
}
