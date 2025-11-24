// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: false, // We don't like SSR over here
  devtools: { enabled: true },

  // Add individual Nuxt SEO modules
  modules: [
    '@nuxtjs/sitemap',
  ],

  // Performance optimizations
  experimental: {
    payloadExtraction: false, // Disable if not needed since SSR is off
  },

  // Site configuration for SEO modules
  site: {
    url: 'https://your-domain.com', // Replace with your actual domain
    name: 'Libre Assistant',
    description: 'An open-source AI assistant interface',
    defaultLocale: 'en', // default locale of your site
  },

  sitemap: {
    enabled: true,
  },

  app: {
    head: {
      title: 'Libre Assistant',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'An open-source AI assistant interface' },
        { name: 'theme-color', content: '#4F46E5' }, // Primary color
        { name: 'format-detection', content: 'telephone=no' },

        // SEO and social media meta tags
        { name: 'application-name', content: 'Libre Assistant' },
        { name: 'apple-mobile-web-app-title', content: 'Libre Assistant' },
        { name: 'twitter:card', content: 'summary' },
        { name: 'twitter:url', content: 'https://your-domain.com' },
        { name: 'twitter:title', content: 'Libre Assistant' },
        { name: 'twitter:description', content: 'An open-source AI assistant interface' },

        // Open Graph tags for social sharing
        { property: 'og:type', content: 'website' },
        { property: 'og:url', content: 'https://your-domain.com' },
        { property: 'og:title', content: 'Libre Assistant' },
        { property: 'og:description', content: 'An open-source AI assistant interface' },
        { property: 'og:site_name', content: 'Libre Assistant' },
        { property: 'og:image', content: '/og-image.png' } // You should add an og-image
      ],
      link: [
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }
      ],
      htmlAttrs: {
        lang: 'en'
      }
    }
  },

  // Optimize build and runtime
  css: [
    // If you have global CSS files
  ],

  // Optimize modules and features
  features: {
    inlineStyles: true, // For client-side rendered apps
  },

  runtimeConfig: {
    // Private config that only the server can access
    hackclubApiKey: '',
    // Public config that is exposed to the client
    public: {
      // Add any public config here
    }
  }
})
