// @ts-check
// Note: type annotations allow type checking and IDEs autocompletion

const prism = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Frameleaf',
  tagline: 'Self-hosted photo and video management solution',
  // FL-188: the owned documentation host is help.frameleaf.ai (see .github/workflows/docs-deploy.yml
  // for the deployment automation status).
  url: 'https://help.frameleaf.ai',
  baseUrl: '/',
  onBrokenLinks: 'throw',
  favicon: 'img/favicon.png',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'Frameleaf', // Usually your GitHub org/user name.
  projectName: 'frameleaf-app', // Usually your repo name.
  deploymentBranch: 'main',
  // Even if you don't use internalization, you can use this field to set useful
  // metadata like html lang. For example, if your site is Chinese, you may want
  // to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  // Mermaid diagrams
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  themes: ['@docusaurus/theme-mermaid'],

  plugins: [
    async function myPlugin(context, options) {
      return {
        name: 'docusaurus-tailwindcss',
        configurePostCss(postcssOptions) {
          // Appends TailwindCSS and AutoPrefixer.
          postcssOptions.plugins.push(require('tailwindcss'));
          postcssOptions.plugins.push(require('autoprefixer'));
          return postcssOptions;
        },
      };
    },
    require.resolve('docusaurus-lunr-search'),
  ],
  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          showLastUpdateAuthor: true,
          showLastUpdateTime: true,
          routeBasePath: '/',

          sidebarPath: require.resolve('./sidebars.js'),
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl: 'https://github.com/Frameleaf/frameleaf-app/tree/fork/main/docs/',
        },
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      docs: {
        sidebar: {
          autoCollapseCategories: false,
        },
      },
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 4,
      },
      navbar: {
        logo: {
          alt: 'Frameleaf Logo',
          src: 'img/frameleaf-logo-inline-light.svg',
          srcDark: 'img/frameleaf-logo-inline-dark.svg',
          className: 'rounded-none',
        },
        items: [
          {
            href: 'https://github.com/Frameleaf/frameleaf-app',
            position: 'right',
            label: 'GitHub',
          },
          {
            type: 'html',
            position: 'right',
            value:
              '<a href="/overview/support-the-project" class="no-underline hover:no-underline"><button class="buy-button bg-immich-primary dark:bg-immich-dark-primary text-white dark:text-black rounded-xl">Support Frameleaf</button></a>',
          },
        ],
      },
      footer: {
        style: 'light',
        links: [
          {
            title: 'Frameleaf',
            items: [
              {
                label: 'Releases',
                href: 'https://github.com/Frameleaf/frameleaf-app/releases',
              },
              {
                label: 'Support Frameleaf',
                to: '/overview/support-the-project',
              },
            ],
          },
          {
            title: 'Community',
            items: [
              {
                label: 'Discussions',
                href: 'https://github.com/Frameleaf/frameleaf-app/discussions',
              },
            ],
          },
          {
            title: 'Social',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/Frameleaf/frameleaf-app',
              },
            ],
          },
        ],
        copyright: `Frameleaf is available as open source under the terms of the GNU AGPL v3 License.`,
      },
      prism: {
        theme: prism.themes.github,
        darkTheme: prism.themes.dracula,
        additionalLanguages: ['sql', 'diff', 'bash', 'powershell', 'nginx'],
      },
      image: 'img/feature-panel.png',
    }),
};

module.exports = config;
