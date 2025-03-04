/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */

// @ts-check

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
    docs: [
        {
            type: 'category',
            label: 'Getting Started',
            items: ['getting-started/introduction', 'getting-started/installation', 'getting-started/first-scene'],
        },
        {
            type: 'category',
            label: 'API',
            items: [
                'api/canvas',
                'api/custom-renderer',
                {
                    type: 'category',
                    label: 'Directives',
                    items: ['api/directives/args', 'api/directives/repeat'],
                },
                {
                    type: 'category',
                    label: 'Pipes',
                    items: ['api/pipes/push'],
                },
                'api/ref',
                'api/primitive',
                'api/raw-value',
                'api/store',
                'api/additional-exports',
            ],
        },
        {
            type: 'category',
            label: 'Advanced',
            items: ['advanced/compound', 'advanced/performance'],
        },
    ],
    // By default, Docusaurus generates a sidebar from the docs folder structure
    //    tutorialSidebar: [{ type: 'autogenerated', dirName: '.' }],

    // But you can create a sidebar manually
    /*
  tutorialSidebar: [
    'intro',
    'hello',
    {
      type: 'category',
      label: 'Tutorial',
      items: ['tutorial-basics/create-a-document'],
    },
  ],
   */
};

module.exports = sidebars;
