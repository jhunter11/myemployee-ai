(function (global) {
  'use strict';

  function url(href) {
    return new URL(href);
  }

  /**
   * A bare /dashboard lands on the configurable main board. An explicit
   * ?view= still wins, so every tab stays directly linkable and indexable.
   */
  function viewFromUrl(href) {
    return url(href).searchParams.get('view') || 'home';
  }

  function isSavedView(href) {
    const view = viewFromUrl(href);
    return view === 'saved' || view === 'pages';
  }

  function laneFromUrl(href) {
    return url(href).searchParams.get('lane') === 'task_market' ? 'task_market' : 'agency';
  }

  function selectedPageSlug(href, pages) {
    const slug = url(href).searchParams.get('page');
    return slug && pages.some((page) => page.slug === slug) ? slug : null;
  }

  function selectedAgentId(href, agents) {
    const agentId = url(href).searchParams.get('agent');
    return agentId && agents.some((agent) => agent.id === agentId) ? agentId : 'jarvis';
  }

  function selectedConversationId(href, conversations) {
    const conversationId = url(href).searchParams.get('conversation');
    return conversationId &&
      conversations.some((conversation) => conversation.id === conversationId)
      ? conversationId
      : null;
  }

  function agentUrl(href, agentId, conversationId) {
    const next = url(href);
    next.searchParams.set('view', 'chat');
    next.searchParams.delete('page');
    next.searchParams.set('agent', agentId);
    if (conversationId) next.searchParams.set('conversation', conversationId);
    else next.searchParams.delete('conversation');
    return next.toString();
  }

  function pageUrl(href, slug) {
    const next = url(href);
    next.searchParams.set('view', 'saved');
    next.searchParams.delete('agent');
    next.searchParams.delete('conversation');
    if (slug) next.searchParams.set('page', slug);
    else next.searchParams.delete('page');
    return next.toString();
  }

  function shouldPushPageUrl(href, slug) {
    return pageUrl(href, slug) !== url(href).toString();
  }

  function viewUrl(href, view) {
    const next = url(href);
    next.searchParams.set('view', view);
    if (view !== 'saved') next.searchParams.delete('page');
    if (view !== 'chat') {
      next.searchParams.delete('agent');
      next.searchParams.delete('conversation');
    }
    return next.toString();
  }

  global.JarvisDashboardNavigation = Object.freeze({
    agentUrl,
    isSavedView,
    laneFromUrl,
    pageUrl,
    selectedAgentId,
    selectedConversationId,
    selectedPageSlug,
    shouldPushPageUrl,
    viewFromUrl,
    viewUrl
  });
})(globalThis);
