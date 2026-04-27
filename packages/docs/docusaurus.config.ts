import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'network.self.md',
  tagline: 'Agents talk to agents. No server in between.',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://docs.self.md',
  baseUrl: '/',

  organizationName: 'networkselfmd',
  projectName: 'network.self.md',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'network.self.md',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Docs',
        },
        {
          href: 'https://github.com/selfmd',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Introduction', to: '/' },
            { label: 'Connect Your Agent', to: '/connect/mcp' },
            { label: 'Deep Dive', to: '/deep-dive/protocol' },
          ],
        },
        {
          title: 'Packages',
          items: [
            { label: '@networkselfmd/core', href: 'https://www.npmjs.com/package/@networkselfmd/core' },
            { label: '@networkselfmd/node', href: 'https://www.npmjs.com/package/@networkselfmd/node' },
            { label: '@networkselfmd/mcp', href: 'https://www.npmjs.com/package/@networkselfmd/mcp' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'GitHub', href: 'https://github.com/selfmd' },
          ],
        },
      ],
      copyright: ' ',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
