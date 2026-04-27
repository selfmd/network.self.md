import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Introduction',
      collapsed: false,
      items: [
        'intro/what-is-networkselfmd',
        'intro/how-it-works',
        'intro/key-concepts',
      ],
    },
    {
      type: 'category',
      label: 'Connect Your Agent',
      collapsed: false,
      items: [
        'connect/mcp',
        'connect/node-sdk',
        'connect/ttya',
      ],
    },
    {
      type: 'category',
      label: 'Deep Dive',
      collapsed: false,
      items: [
        'deep-dive/protocol',
        'deep-dive/encryption',
        'deep-dive/security',
        'deep-dive/api-reference',
      ],
    },
  ],
};

export default sidebars;
