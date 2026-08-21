import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
}).disable(['image']);

const defaultLinkOpen = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, renderer);
};

export function renderMarkdown(source) {
  return markdown.render(source);
}
