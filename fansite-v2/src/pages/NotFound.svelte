<script>
  import Page from '../lib/Page.svelte'
  import { t } from '../i18n.svelte.js'
  import { route } from '../router.svelte.js'
</script>

<Page title={t('page.notFound')}>
  <p class="font-mono text-sm text-berry-fg-3">{route.path}</p>
  <a href="/" class="mt-4 inline-block text-sm">{t('common.backHome')}</a>
</Page>
