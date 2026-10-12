import { defineConfig } from 'vitepress'

/**
 * 小白录制 官网。
 *
 * 站点挂在博客（仓库根，Astro）的子路径下，所以 base 必须是 /screenrecorder/，
 * 构建产物由根目录的 .github/workflows/deploy.yml 复制到 public/screenrecorder/。
 */
export default defineConfig({
  lang: 'zh-CN',
  title: '小白录制',
  description:
    '本机运行的高帧率屏幕录制与视频处理工具：系统录屏 / Shizuku / Root 三种采集方式，无账号、无云端、不上传。',
  base: '/screenrecorder/',
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/screenrecorder/icon.png' }],
    ['meta', { name: 'theme-color', content: '#277af7' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: '小白录制 · 高帧率屏幕录制与视频处理' }],
    [
      'meta',
      {
        property: 'og:description',
        content: '系统录屏 / Shizuku / Root 三种采集方式，系统声音与麦克风混音，区域录制、悬浮球、屏幕标注与视频工具箱。',
      },
    ],
    ['meta', { property: 'og:image', content: '/screenrecorder/icon.png' }],
  ],
  themeConfig: {
    logo: '/icon.png',
    nav: [
      { text: '首页', link: '/' },
      { text: '使用指南', link: '/guide/' },
      { text: '版本对比', link: '/versions' },
      { text: '视频工具箱', link: '/tools' },
      { text: '常见问题', link: '/faq' },
      {
        text: '条款',
        items: [
          { text: '隐私政策', link: '/privacy' },
          { text: '用户协议', link: '/terms' },
          { text: '更新日志', link: '/changelog' },
        ],
      },
      { text: '博客', link: 'https://sunightz.github.io/' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始使用',
          items: [
            { text: '总览', link: '/guide/' },
            { text: '安装与首次启动', link: '/guide/install' },
            { text: '权限说明', link: '/guide/permissions' },
          ],
        },
        {
          text: '录制',
          items: [
            { text: '录制参数', link: '/guide/parameters' },
            { text: '声音与增益', link: '/guide/audio' },
            { text: '区域录制', link: '/guide/region' },
            { text: '悬浮球与屏幕标注', link: '/guide/floating' },
          ],
        },
        {
          text: '录制之后',
          items: [
            { text: '保存位置与相册', link: '/guide/album' },
            { text: '视频工具箱', link: '/tools' },
          ],
        },
      ],
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            displayDetails: '显示详细列表',
            resetButtonTitle: '清除查询条件',
            backButtonTitle: '返回',
            noResultsText: '没有找到相关结果',
            footer: {
              selectText: '选择',
              selectKeyAriaLabel: '回车',
              navigateText: '切换',
              navigateUpKeyAriaLabel: '上箭头',
              navigateDownKeyAriaLabel: '下箭头',
              closeText: '关闭',
              closeKeyAriaLabel: 'Esc',
            },
          },
        },
      },
    },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    footer: {
      message: '全部处理都在你的设备上完成 · 无账号 · 无云端 · 不上传',
      copyright: '© 2026 左一铭 · 鲁ICP备2024133585号-2A',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/SunightZ' }],
  },
})
