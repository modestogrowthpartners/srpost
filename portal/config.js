// Configuracao do portal e do painel. Cada endereco aponta para uma Edge Function do projeto no Supabase:
//   api     portal do cliente, painel do time, ingestao, Instagram e publicador
//   agents  central de agentes, banco de pautas, chaves e integracoes
//   chat    chat de diagnostico do time
window.SRPOST = {
  api: "https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api",
  agents: "https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/agents",
  chat: "https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/chat",
};
// Qual funcao atende cada rota do painel.
window.SRPOST.base = function (path) {
  var c = window.SRPOST;
  if (/^\/admin\/chat(\/|\?|$)/.test(path)) return c.chat || c.api.replace(/\/api$/, "/chat");
  if (/^\/admin\/(agents|runs|integrations|bank)(\/|\?|$)/.test(path)) return c.agents || c.api.replace(/\/api$/, "/agents");
  return c.api;
};
