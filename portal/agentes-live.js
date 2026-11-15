/* Sr. Post: visao ao vivo dos agentes. Define window.SrpLive = { mount(container, opts) }.

   Uso (a pagina passa a funcao que chama GET /admin/agents/live):
     var vivo = SrpLive.mount(el, { load: function (after, clientId) { ... }, agents: [...], clientId: null, onRun: fn, interval: 3000 });
     vivo.refresh(); vivo.setAgents(lista); vivo.stop();

   ============================================================================================
   REGRA QUE TRANSFORMA DADOS EM ESTADO VISUAL (para auditoria: nada acende sem evento real)
   ============================================================================================
   Fonte unica: a resposta de opts.load(), ou seja, linhas reais de agent_events (events) e de
   agent_runs (runs). O modulo nao guarda estado proprio alem dessas linhas e nao simula nada.

   "Ultimo evento" de uma etapa = o evento de maior id com aquele run_id e aquele step, entre os
   que estao na memoria (no maximo 500, sempre os mais novos).

   A. Execucao em andamento (status rodando, aguardando_midia, aguardando_aprovacao, publicando).
      Etapa atual = run.step.
      1. Etapa antes da atual: CONCLUIDA. O motor so avanca run.step depois de gravar o evento
         "ok" da etapa, entao a posicao da execucao no banco e a prova. Excecao: se o ultimo
         evento da etapa for "pulou", ela fica PARADA com o texto "pulada".
      2. Etapa depois da atual: PARADA. Eventos antigos nao contam: quando o cliente pede ajuste,
         a execucao volta para o roteiro e as etapas seguintes ainda vao rodar de novo.
      3. Etapa atual, nesta ordem (a primeira que casar vale):
         a. ultimo evento "falhou"                                   -> FALHOU (mensagem do evento)
         b. status aguardando_midia e etapa midia                    -> AGUARDANDO "aguardando mídia"
         c. status aguardando_aprovacao e etapa aprovacao            -> AGUARDANDO "aguardando o cliente"
         d. ultimo evento "iniciou" e status rodando ou publicando   -> RODANDO (unico estado com energia)
         e. status publicando e etapa publicar (post aprovado, nas maos do publicador) -> AGUARDANDO.
            O texto sai do ultimo evento: "aguardando" = "agendado"; "ok" = "parte publicada" (uma rede
            ja publicou e ainda ha publicacao em aberto); sem evento na memoria = "na fila de publicação"
         f. ultimo evento "ok" e ele e o evento mais novo da execucao -> CONCLUIDA
            (instante entre o evento e o avanco de run.step)
         g. qualquer outro caso                                      -> PARADA com o texto "próxima"
            (a execucao espera o proximo ciclo do motor; nao ha evento "iniciou", entao nao acende)
   B. Execucao com status falhou: a etapa run.step fica FALHOU (mensagem = run.error) e as
      anteriores ficam CONCLUIDA.
   C. Execucao concluida ou cancelada: nao entra no desenho do agente. Aparece so na lista e,
      quando selecionada, mostra como CONCLUIDA as etapas ate run.step (cancelada: so as anteriores).

   Linha do agente (conjunto): entram as execucoes dos casos A e B. Cada etapa mostra o estado de
   maior prioridade entre elas: rodando > falhou > aguardando > concluida > parada. O numero no no
   e a quantidade de execucoes em andamento cuja etapa atual e aquela (aparece com 2 ou mais
   execucoes em andamento). O sinal "!" avisa que ha falha naquela etapa quando o estado mostrado
   e outro. A execucao que falhou fica no desenho enquanto a API a devolve (ate 30 minutos depois
   da ultima mudanca); depois disso o erro continua na central, na lista de erros do agente.

   Animacao (so duas, as duas presas a evento real):
     Energia: tracos em movimento na linha que chega ao no e anel pulsando no no. Existe somente no
       estado RODANDO, isto e, com o evento "iniciou" da regra 3d. Para quando os dados tem mais de
       30 segundos, quando load() falha e quando o painel e parado.
     Pulso: um por evento "ok" que chega com a pagina aberta. Vale so para evento que ainda nao
       estava na memoria, vindo de uma consulta que nao e a carga inicial e criado ha poucos
       segundos (evento antigo recebido com atraso nao pulsa). Se a execucao ja avancou, o pulso
       percorre a linha ate o proximo no; senao (ultima etapa, ou post que nao seguiu adiante) o no
       da propria etapa pisca uma vez.
   Com prefers-reduced-motion nada se move: o estado aparece so por cor, forma, icone e texto.
*/
(function () {
  "use strict";

  var STEPS = ["planejar", "roteiro", "copy", "midia", "aprovacao", "publicar"];
  var STEP_LABEL = { planejar: "Planejar", roteiro: "Roteiro", copy: "Copy", midia: "Gerar mídia", aprovacao: "Fila de aprovação", publicar: "Publicar", config: "Configuração" };
  var ACTIVE = { rodando: true, aguardando_midia: true, aguardando_aprovacao: true, publicando: true };
  var RUN_END = { concluido: "concluído", falhou: "falhou", cancelado: "cancelado" };
  var FORMAT = { reel: "Reel", carrossel: "Carrossel", imagem: "Imagem", story: "Story" };
  var EV_STATUS = { iniciou: "iniciou", ok: "concluiu", falhou: "falhou", aguardando: "aguardando", info: "registro", pulou: "pulou" };
  var SR = { idle: "sem atividade", running: "rodando", waiting: "aguardando", done: "concluída", failed: "falhou" };
  var RANK = { idle: 0, done: 1, waiting: 2, failed: 3, running: 4 };
  // Icone de cada estado (alem da cor e da forma do no): raio, relogio, visto e xis. Parada mostra o numero da etapa.
  var ICON = {
    running: ["M9.2 1.5 3.6 9H8l-1.2 5.5L12.4 7H8z", true],
    waiting: ["M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2zM8 5v3.2l2.2 1.4", false],
    done: ["M3.4 8.6l3 3 6.2-7", false],
    failed: ["M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6", false]
  };
  var MAX_EVENTS = 500, STALE_MS = 30000, MAX_BACKOFF_MS = 60000, HIDDEN_RESET_MS = 60000, SCHED_LATE_MS = 180000, NARROW_PX = 760;
  var SVGNS = "http://www.w3.org/2000/svg";

  var CSS = [
    ".lv-root { --lv-ink: var(--ink, #0B0F14); --lv-line: var(--line, #B5C0CD); --lv-card: var(--card, #FFFFFF); --lv-bg: var(--bg, #F4F7FA); --lv-sky: var(--sky, #DCE6F2);",
    "  --lv-butter: var(--butter, #FFA070); --lv-approve: var(--approve, #13243B); --lv-error: var(--error, #B3361F); --lv-error-soft: var(--error-soft, #F7DDD6); --lv-muted: var(--muted, #4E5B6B);",
    "  --lv-display: var(--display, 'Chakra Petch', 'Arial Narrow', Arial, sans-serif); --lv-body: var(--body, 'Space Mono', ui-monospace, Menlo, Consolas, monospace);",
    "  display: grid; gap: 12px; min-width: 0; color: var(--lv-ink); font-family: var(--lv-body); font-size: 0.82rem; line-height: 1.45; }",
    ".lv-root *, .lv-root *::before, .lv-root *::after { box-sizing: border-box; }",
    ".lv-root [hidden] { display: none !important; }",
    ".lv-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }",
    /* cabecalho */
    ".lv-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 8px 14px; border: 1.5px solid var(--lv-ink); border-radius: 12px; background: var(--lv-card); min-width: 0; }",
    ".lv-conn { display: inline-flex; align-items: center; gap: 7px; font-family: var(--lv-display); font-weight: 700; font-size: 0.74rem; letter-spacing: 0.09em; text-transform: uppercase; white-space: nowrap; }",
    ".lv-conn::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: var(--lv-approve); }",
    ".lv-frozen .lv-conn::before { border-radius: 2px; background: var(--lv-error); }",
    ".lv-m-loading .lv-conn::before { background: var(--lv-line); }",
    ".lv-upd, .lv-sum, .lv-sched { color: var(--lv-muted); font-size: 0.76rem; overflow-wrap: anywhere; min-width: 0; }",
    ".lv-sched.lv-warn { color: var(--lv-error); }",
    ".lv-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; padding: 10px 14px; border: 1.5px solid var(--lv-error); border-radius: 12px; background: var(--lv-error-soft); overflow-wrap: anywhere; }",
    ".lv-btn { min-height: 32px; padding: 0 12px; border: 1.5px solid var(--lv-ink); border-radius: 999px; background: var(--lv-card); color: var(--lv-ink); font: inherit; font-weight: 700; font-size: 0.74rem; white-space: nowrap; cursor: pointer; }",
    ".lv-btn:hover { background: var(--lv-sky); }",
    ".lv-root button:focus-visible { outline: 3px solid var(--blue, #668EC2); outline-offset: 2px; }",
    ".lv-empty { margin: 0; color: var(--lv-muted); }",
    /* linha de um agente */
    ".lv-rows { display: grid; gap: 10px; min-width: 0; }",
    ".lv-frozen .lv-rows { opacity: 0.6; }",
    ".lv-row { display: grid; gap: 10px; padding: 12px; border: 1.5px solid var(--lv-line); border-radius: 14px; background: var(--lv-bg); min-width: 0; }",
    ".lv-main { display: grid; grid-template-columns: minmax(0, 210px) minmax(0, 1fr); column-gap: 30px; align-items: start; min-width: 0; }",
    ".lv-agent { display: grid; gap: 5px; align-content: start; min-width: 0; min-height: 36px; padding: 8px 12px; border: 1.5px solid var(--lv-ink); border-radius: 12px; background: var(--lv-card); }",
    ".lv-aname { font-family: var(--lv-display); font-size: 0.98rem; line-height: 1.15; overflow-wrap: anywhere; }",
    ".lv-tags { display: flex; flex-wrap: wrap; gap: 4px; }",
    ".lv-tag { display: inline-flex; align-items: center; min-height: 19px; padding: 0 7px; border: 1.5px solid var(--lv-ink); border-radius: 999px; background: var(--lv-sky); font-family: var(--lv-display); font-weight: 600; font-size: 0.66rem; white-space: nowrap; }",
    ".lv-tag.lv-auto-on { background: var(--lv-approve); color: #FFF; }",
    ".lv-tag.lv-auto-off { background: var(--lv-card); border-style: dashed; }",
    ".lv-tag.lv-demo, .lv-tag.lv-simtag { background: var(--lv-butter); }",
    ".lv-count { color: var(--lv-muted); font-size: 0.74rem; }",
    /* etapas: no + linha que chega nele */
    ".lv-track { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); min-width: 0; }",
    ".lv-step { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); justify-items: center; align-content: start; gap: 4px; min-width: 0; padding: 0 3px; text-align: center; }",
    ".lv-link { position: absolute; top: 12px; left: calc(-50% + 20px); width: calc(100% - 40px); height: 12px; overflow: hidden; pointer-events: none; }",
    ".lv-step:first-child .lv-link { left: -30px; width: calc(50% + 10px); }",
    ".lv-link svg { display: block; width: 100%; height: 100%; }",
    ".lv-wire { stroke: var(--lv-line); stroke-width: 2; }",
    ".lv-walked .lv-wire { stroke: var(--lv-approve); }",
    ".lv-pathon .lv-wire { stroke: var(--lv-ink); stroke-width: 3.5; }",
    ".lv-glow, .lv-flow { display: none; stroke: var(--lv-butter); stroke-linecap: round; stroke-dasharray: 10 18; }",
    ".lv-energy .lv-wire { stroke: var(--lv-ink); }",
    ".lv-energy .lv-glow { display: inline; stroke-width: 9; opacity: 0.35; animation: lv-flow 0.9s linear infinite; }",
    ".lv-energy .lv-flow { display: inline; stroke-width: 3.5; animation: lv-flow 0.9s linear infinite; }",
    "@keyframes lv-flow { from { stroke-dashoffset: 28; } to { stroke-dashoffset: 0; } }",
    ".lv-pulse { position: absolute; inset: 0; animation: lv-pulse-x 0.9s cubic-bezier(0.35, 0, 0.3, 1) 1 both; }",
    ".lv-pulse::before { content: ''; position: absolute; left: -5px; top: 50%; width: 10px; height: 10px; margin-top: -5px; border: 1.5px solid var(--lv-ink); border-radius: 50%; background: var(--lv-butter); }",
    "@keyframes lv-pulse-x { from { transform: translateX(0); } to { transform: translateX(100%); } }",
    "@keyframes lv-pulse-y { from { transform: translateY(0); } to { transform: translateY(100%); } }",
    ".lv-node { position: relative; z-index: 1; flex: none; width: 36px; height: 36px; display: grid; place-items: center; color: var(--lv-muted); }",
    ".lv-shape { position: absolute; inset: 0; border: 1.5px solid var(--lv-line); border-radius: 50%; background: var(--lv-card); }",
    ".lv-num { position: relative; font-family: var(--lv-display); font-weight: 600; font-size: 0.78rem; }",
    ".lv-ico { position: relative; display: none; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }",
    ".lv-ico.lv-fill { fill: currentColor; stroke: none; }",
    ".lv-step:not(.lv-idle) .lv-num { display: none; }",
    ".lv-step:not(.lv-idle) .lv-ico { display: block; }",
    ".lv-badge { position: absolute; top: -6px; right: -8px; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 999px; background: var(--lv-ink); color: #FFF; font-weight: 700; font-size: 0.64rem; line-height: 17px; text-align: center; }",
    ".lv-flagdot { position: absolute; bottom: -5px; right: -7px; width: 15px; height: 15px; border-radius: 4px; background: var(--lv-error); color: #FFF; font-weight: 700; font-size: 0.64rem; line-height: 15px; text-align: center; }",
    ".lv-text { display: grid; justify-items: center; gap: 1px; min-width: 0; max-width: 100%; }",
    ".lv-name { font-family: var(--lv-display); font-weight: 600; font-size: 0.68rem; letter-spacing: 0.07em; text-transform: uppercase; color: var(--lv-muted); overflow-wrap: anywhere; }",
    ".lv-state { min-height: 2.9em; font-size: 0.7rem; color: var(--lv-muted); overflow-wrap: anywhere; }",
    /* estados: cada um tem cor, forma e icone proprios */
    ".lv-running .lv-node, .lv-waiting .lv-node { color: var(--lv-ink); }",
    ".lv-running .lv-shape { border: 2px solid var(--lv-ink); background: var(--lv-butter); }",
    ".lv-running .lv-shape::after { content: ''; position: absolute; inset: -7px; border: 2px solid var(--lv-butter); border-radius: 50%; animation: lv-ring 1.4s ease-out infinite; }",
    "@keyframes lv-ring { from { transform: scale(0.82); opacity: 0.95; } to { transform: scale(1.3); opacity: 0; } }",
    ".lv-running .lv-name, .lv-waiting .lv-name, .lv-done .lv-name { color: var(--lv-ink); }",
    ".lv-running .lv-state { color: var(--lv-ink); font-weight: 700; }",
    ".lv-waiting .lv-shape { border: 1.5px solid var(--lv-ink); border-radius: 9px; background: var(--lv-sky); }",
    ".lv-waiting .lv-state { color: var(--lv-ink); }",
    ".lv-done .lv-node { color: #FFF; }",
    ".lv-done .lv-shape { border-color: var(--lv-approve); background: var(--lv-approve); }",
    ".lv-failed .lv-node { color: var(--lv-error); }",
    ".lv-failed .lv-shape { inset: 4px; border: 2px solid var(--lv-error); border-radius: 5px; background: var(--lv-error-soft); transform: rotate(45deg); }",
    ".lv-failed .lv-name, .lv-failed .lv-state { color: var(--lv-error); }",
    ".lv-ripple { position: absolute; inset: -4px; border: 2px solid var(--lv-approve); border-radius: 50%; animation: lv-ripple 0.9s ease-out 1 both; pointer-events: none; }",
    "@keyframes lv-ripple { from { transform: scale(0.9); opacity: 0.9; } to { transform: scale(1.6); opacity: 0; } }",
    /* sem dado novo ou sem conexao: nenhuma energia */
    ".lv-frozen .lv-glow, .lv-frozen .lv-flow, .lv-frozen .lv-shape::after { display: none; }",
    /* ultimo evento, falhas, execucoes e eventos */
    ".lv-last { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-width: 0; font-size: 0.78rem; }",
    ".lv-msg { flex: 1 1 220px; min-width: 0; overflow-wrap: anywhere; }",
    ".lv-ago { color: var(--lv-muted); white-space: nowrap; }",
    ".lv-errs { display: grid; gap: 4px; padding: 8px 12px; border: 1.5px solid var(--lv-error); border-radius: 10px; background: var(--lv-error-soft); color: var(--lv-error); font-size: 0.78rem; overflow-wrap: anywhere; }",
    ".lv-errs p { margin: 0; }",
    ".lv-sel { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 0.76rem; color: var(--lv-muted); }",
    ".lv-runs, .lv-feed { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; min-width: 0; }",
    ".lv-run { width: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 3px 10px; min-width: 0; padding: 8px 10px; border: 1.5px solid var(--lv-line); border-radius: 10px; background: var(--lv-card); color: var(--lv-ink); font: inherit; text-align: left; cursor: pointer; }",
    ".lv-run:hover { background: var(--lv-sky); }",
    ".lv-run[aria-pressed='true'] { border-color: var(--lv-ink); box-shadow: inset 5px 0 0 var(--lv-ink); padding-left: 14px; }",
    ".lv-t { flex: 1 1 320px; min-width: 0; overflow-wrap: anywhere; }",
    ".lv-m { color: var(--lv-muted); font-size: 0.74rem; overflow-wrap: anywhere; min-width: 0; }",
    ".lv-rs { color: var(--lv-ink); }",
    ".lv-run.lv-rfail .lv-rs { color: var(--lv-error); font-weight: 700; }",
    ".lv-feed { gap: 4px; padding-top: 8px; border-top: 1.5px dashed var(--lv-line); }",
    ".lv-ev { display: grid; grid-template-columns: auto auto auto minmax(0, 1fr); gap: 0 10px; font-size: 0.74rem; min-width: 0; }",
    ".lv-ev span { overflow-wrap: anywhere; min-width: 0; }",
    ".lv-evt, .lv-evs { color: var(--lv-muted); white-space: nowrap; }",
    ".lv-evp { font-family: var(--lv-display); font-weight: 600; }",
    ".lv-ev.lv-evfail .lv-evs, .lv-ev.lv-evfail .lv-evm { color: var(--lv-error); }",
    /* coluna estreita: trilha vertical, com a linha ligando os nos de cima para baixo */
    ".lv-narrow .lv-main { grid-template-columns: minmax(0, 1fr); }",
    ".lv-narrow .lv-track { grid-template-columns: minmax(0, 1fr); padding-left: 14px; }",
    ".lv-narrow .lv-step { grid-template-columns: 36px minmax(0, 1fr); justify-items: start; align-items: center; column-gap: 12px; padding: 12px 0 0; text-align: left; }",
    ".lv-narrow .lv-link, .lv-narrow .lv-step:first-child .lv-link { left: 12px; top: 0; width: 12px; height: 12px; }",
    ".lv-narrow .lv-pulse { animation-name: lv-pulse-y; }",
    ".lv-narrow .lv-pulse::before { left: 50%; top: -5px; margin: 0 0 0 -5px; }",
    ".lv-narrow .lv-text { display: flex; flex-wrap: wrap; align-items: baseline; justify-items: start; gap: 0 10px; }",
    ".lv-narrow .lv-state { min-height: 0; }",
    ".lv-narrow .lv-ev { grid-template-columns: auto auto minmax(0, 1fr); }",
    ".lv-narrow .lv-evm { grid-column: 1 / -1; }",
    /* sem movimento: o estado fica so na cor, na forma, no icone e no texto */
    "@media (prefers-reduced-motion: reduce) {",
    "  .lv-root *, .lv-root *::before, .lv-root *::after { animation: none !important; transition: none !important; }",
    "  .lv-energy .lv-glow, .lv-running .lv-shape::after { display: none; }",
    "  .lv-energy .lv-flow { stroke-dasharray: none; }",
    "}"
  ].join("\n");

  function injectStyle() {
    if (document.getElementById("lv-style")) return;
    var s = document.createElement("style"); s.id = "lv-style"; s.textContent = CSS;
    document.head.appendChild(s);
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function sv(tag, attrs) { var n = document.createElementNS(SVGNS, tag), k; for (k in attrs) n.setAttribute(k, attrs[k]); return n; }
  function ms(iso) { var t = iso ? Date.parse(iso) : NaN; return isNaN(t) ? null : t; }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function hhmm(t) { var d = new Date(t); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  // Horario do computador de quem olha, como no resto do painel. Com a data quando nao e hoje.
  function stamp(t, secs) {
    var d = new Date(t), n = new Date(), today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return (today ? "" : pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + " ") + hhmm(t) + (secs ? ":" + pad(d.getSeconds()) : "");
  }
  function ago(age) {
    var s = Math.max(0, Math.round(age / 1000));
    if (s < 60) return "há " + s + " s";
    if (s < 3600) return "há " + Math.floor(s / 60) + " min";
    if (s < 172800) return "há " + Math.floor(s / 3600) + " h";
    return "há " + Math.floor(s / 86400) + " d";
  }
  function took(v) { return v < 1000 ? v + " ms" : v < 60000 ? String(Math.round(v / 100) / 10).replace(".", ",") + " s" : Math.round(v / 60000) + " min"; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  // Escreve no DOM so quando o valor muda (uma consulta sem novidade nao toca em nada).
  function hide(n, v) { if (n.hidden !== v) n.hidden = v; }
  function put(n, t) { if (n.textContent !== t) n.textContent = t; }
  function sentence(t) { t = String(t || "").trim(); return t && !/[.!?]$/.test(t) ? t + "." : t; }
  function view(state, label, tip, long, bump) { return { state: state, label: label || "", tip: tip || "", long: long || label || SR[state], rank: RANK[state] + (bump || 0) }; }

  // Regra 3 do cabecalho: estado da etapa atual de uma execucao em andamento.
  function current(run, step, ev, newest) {
    var st = run.status, last = ev ? ev.status : "", msg = ev ? ev.message : "", retry, v;
    if (last === "falhou") {
      if (step === "publicar") return view("failed", "falhou em uma rede", msg);
      // Nas etapas de geracao o motor marca a nova tentativa em next_step_at (2, 10 e 30 minutos).
      retry = step === "aprovacao" ? null : ms(run.next_step_at);
      v = view("failed", retry ? "falhou, nova tentativa " + hhmm(retry) : "falhou", msg);
      if (retry) v.note = "Nova tentativa às " + hhmm(retry) + ".";
      return v;
    }
    if (st === "aguardando_midia" && step === "midia") {
      return view("waiting", "aguardando mídia", msg, run.midia_modo === "manual" ? "aguardando o time enviar a mídia" : run.midia_modo === "async" ? "aguardando o gerador de mídia" : "");
    }
    if (st === "aguardando_aprovacao" && step === "aprovacao") return view("waiting", "aguardando o cliente", msg);
    if (last === "iniciou" && (st === "rodando" || st === "publicando")) return view("running", "rodando", msg, "rodando desde " + stamp(ms(ev.created_at) || Date.now(), true));
    if (st === "publicando" && step === "publicar") {
      if (last === "aguardando") return view("waiting", "agendado", msg);
      if (last === "ok") return view("waiting", "parte publicada", msg, "parte publicada, ainda há publicação em aberto");
      return view("waiting", "na fila de publicação", msg);
    }
    if (last === "ok" && newest && newest.id === ev.id) return view("done", "concluída", msg);
    return view("idle", "próxima", msg, "espera o próximo ciclo do motor", 0.5);
  }

  // Estado das seis etapas para uma execucao (regras A, B e C do cabecalho). idx = eventos dessa execucao.
  function runPath(run, idx) {
    var by = idx ? idx.by : {}, newest = idx ? idx.last : null;
    var cur = STEPS.indexOf(run.step), st = run.status, out = [], i, ev, msg;
    for (i = 0; i < STEPS.length; i++) {
      ev = by[STEPS[i]] || null; msg = ev ? ev.message : "";
      if (cur < 0) out.push(view("idle"));
      else if (st === "falhou") out.push(i < cur ? view("done", "concluída", msg) : i === cur ? view("failed", "falhou", run.error || msg) : view("idle"));
      else if (ACTIVE[st] === true) {
        if (i < cur) out.push(ev && ev.status === "pulou" ? view("idle", "pulada", msg, "etapa pulada") : view("done", "concluída", msg));
        else out.push(i > cur ? view("idle") : current(run, STEPS[i], ev, newest));
      }
      else if (st === "concluido") out.push(i <= cur ? view("done", "concluída", msg) : view("idle"));
      else out.push(i < cur ? view("done", "concluída", msg) : view("idle"));
    }
    return out;
  }

  function mount(container, opts) {
    if (!container || !container.appendChild) throw new Error("SrpLive.mount: informe o elemento que recebe a visão ao vivo.");
    opts = opts || {};
    if (container.__srpLive) container.__srpLive.stop();
    injectStyle();

    var interval = Math.max(250, Number(opts.interval) || 3000);
    var only = opts.clientId || null;
    var load = typeof opts.load === "function" ? opts.load : function () { return Promise.reject(new Error("A página não informou como buscar os dados.")); };
    var motion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var freshMs = Math.max(15000, interval * 3), timeoutMs = Math.max(20000, interval * 4);

    var events = [], seen = {}, runs = [], sched = null, cursor = 0, baseline = true, gotData = false, speak = false;
    var offset = 0, lastOk = 0, fails = 0, offline = null, retryAt = 0;
    var stopped = false, inflight = false, again = false, seq = 0, pollTimer = null, tickTimer = null, guardTimer = null, hiddenAt = 0;
    var agents = [], rows = {}, order = [], ctx = { idx: {}, lastBy: {}, countBy: {}, runsBy: {} }, narrow = false, observer = null, mode = "", schedLate = false, notice = "";

    // ---------- esqueleto ----------
    var root = el("section", "lv-root");
    root.setAttribute("role", "region"); root.setAttribute("aria-label", only ? "Agente ao vivo" : "Agentes ao vivo");
    var conn = el("span", "lv-conn"), upd = el("span", "lv-upd"), sum = el("span", "lv-sum"), schedEl = el("span", "lv-sched");
    var head = el("div", "lv-head"); head.appendChild(conn); head.appendChild(upd); head.appendChild(sum); head.appendChild(schedEl);
    var banner = el("div", "lv-banner"), bannerText = el("span"), retryBtn = el("button", "lv-btn", "Tentar agora");
    retryBtn.type = "button"; retryBtn.addEventListener("click", function () { refresh(); });
    banner.appendChild(bannerText); banner.appendChild(retryBtn); banner.hidden = true;
    var list = el("div", "lv-rows"), empty = el("p", "lv-empty", "Nenhum agente para mostrar."), say = el("div", "lv-sr");
    say.setAttribute("aria-live", "polite");
    root.appendChild(head); root.appendChild(banner); root.appendChild(empty); root.appendChild(list); root.appendChild(say);
    container.textContent = ""; container.appendChild(root);

    // ---------- linhas ----------
    function orient(r) {
      r.steps.forEach(function (s) {
        s.lines.forEach(function (ln) {
          ln.setAttribute("x1", narrow ? "50%" : "0"); ln.setAttribute("y1", narrow ? "0" : "50%");
          ln.setAttribute("x2", narrow ? "50%" : "100%"); ln.setAttribute("y2", narrow ? "100%" : "50%");
        });
      });
    }
    function buildRow(a) {
      var r = { id: a.client_id, agent: a, steps: [], sig: {}, prev: null, selected: null, preview: null, feedOpen: false, feedLimit: 15, runsLimit: 5, btns: {}, runOrder: "", agoT: null, agoText: "" };
      r.root = el("div", "lv-row"); r.root.setAttribute("role", "group"); r.root.setAttribute("data-client", a.client_id);
      var main = el("div", "lv-main");
      r.node = el("div", "lv-agent"); r.name = el("b", "lv-aname"); r.tags = el("span", "lv-tags"); r.count = el("span", "lv-count");
      r.node.appendChild(r.name); r.node.appendChild(r.tags); r.node.appendChild(r.count);
      r.track = el("ol", "lv-track"); r.track.setAttribute("aria-label", "Etapas do post");
      STEPS.forEach(function (step, i) {
        var s = { sig: "" };
        s.li = el("li", "lv-step lv-idle"); s.li.setAttribute("data-step", step); s.li.setAttribute("data-state", "idle");
        s.link = el("span", "lv-link"); s.link.setAttribute("aria-hidden", "true");
        var g = sv("svg", { focusable: "false" });
        s.lines = [sv("line", { "class": "lv-wire" }), sv("line", { "class": "lv-glow" }), sv("line", { "class": "lv-flow" })];
        s.lines.forEach(function (ln) { g.appendChild(ln); }); s.link.appendChild(g);
        s.node = el("span", "lv-node"); s.node.setAttribute("aria-hidden", "true");
        s.ico = sv("svg", { "class": "lv-ico", viewBox: "0 0 16 16", focusable: "false" }); s.icoPath = sv("path", { d: "" }); s.ico.appendChild(s.icoPath);
        s.badge = el("span", "lv-badge"); s.badge.hidden = true; s.flag = el("span", "lv-flagdot", "!"); s.flag.hidden = true;
        s.node.appendChild(el("span", "lv-shape")); s.node.appendChild(el("span", "lv-num", String(i + 1))); s.node.appendChild(s.ico); s.node.appendChild(s.badge); s.node.appendChild(s.flag);
        var text = el("span", "lv-text"); s.st = el("span", "lv-state"); s.sr = el("span", "lv-sr", SR.idle);
        text.appendChild(el("span", "lv-name", STEP_LABEL[step])); text.appendChild(s.st); text.appendChild(s.sr);
        s.li.appendChild(s.link); s.li.appendChild(s.node); s.li.appendChild(text);
        r.track.appendChild(s.li); r.steps.push(s);
      });
      main.appendChild(r.node); main.appendChild(r.track);
      r.last = el("div", "lv-last"); r.msg = el("span", "lv-msg", "Carregando eventos..."); r.ago = el("span", "lv-ago");
      r.feedBtn = el("button", "lv-btn"); r.feedBtn.type = "button"; r.feedBtn.hidden = true; r.feedBtn.setAttribute("aria-expanded", "false");
      r.feedBtn.addEventListener("click", function () { r.feedOpen = !r.feedOpen; r.feedLimit = 15; renderRow(r, null); });
      r.last.appendChild(r.msg); r.last.appendChild(r.ago); r.last.appendChild(r.feedBtn);
      r.errs = el("div", "lv-errs"); r.errs.hidden = true;
      r.sel = el("div", "lv-sel"); r.sel.hidden = true;
      var back = el("button", "lv-btn", "Ver todas as execuções"); back.type = "button";
      back.addEventListener("click", function () { r.selected = null; renderRow(r, null); });
      r.sel.appendChild(el("span", null, "A trilha mostra só a execução selecionada.")); r.sel.appendChild(back);
      r.runs = el("ul", "lv-runs"); r.runs.hidden = true;
      r.moreRuns = el("button", "lv-btn"); r.moreRuns.type = "button"; r.moreRuns.hidden = true;
      r.moreRuns.addEventListener("click", function () { r.runsLimit += 10; renderRow(r, null); });
      r.feed = el("ol", "lv-feed"); r.feed.hidden = true;
      r.moreFeed = el("button", "lv-btn", "Mostrar mais eventos"); r.moreFeed.type = "button"; r.moreFeed.hidden = true;
      r.moreFeed.addEventListener("click", function () { r.feedLimit += 30; renderRow(r, null); });
      // O aviso de selecao fica depois da lista: quando ele some, as execucoes nao mudam de lugar debaixo do ponteiro.
      [main, r.last, r.errs, r.runs, r.moreRuns, r.sel, r.feed, r.moreFeed].forEach(function (n) { r.root.appendChild(n); });
      orient(r);
      return r;
    }
    function syncRows() {
      var want = agents.filter(function (a) { return !only || a.client_id === only; }), keep = {}, ids = [];
      want.forEach(function (a) { if (keep[a.client_id]) return; keep[a.client_id] = true; ids.push(a.client_id); if (rows[a.client_id]) rows[a.client_id].agent = a; else rows[a.client_id] = buildRow(a); });
      Object.keys(rows).forEach(function (id) { if (!keep[id]) { if (rows[id].root.parentNode) list.removeChild(rows[id].root); delete rows[id]; } });
      if (ids.join(",") !== order.join(",") || list.children.length !== ids.length) ids.forEach(function (id) { list.appendChild(rows[id].root); });
      order = ids; empty.hidden = ids.length > 0;
    }
    function normalize(listIn) {
      return (Array.isArray(listIn) ? listIn : []).filter(function (a) { return a && a.client_id; }).map(function (a) {
        return { client_id: String(a.client_id), name: String(a.name || "Agente sem nome"), is_demo: a.is_demo === true, automation: a.automation === "ligada" ? "ligada" : "pausada" };
      });
    }

    // ---------- desenho de uma linha: so muda no DOM o que mudou nos dados ----------
    function applyStep(s, v, count, flagged, pathOn) {
      var sig = v.state + "|" + v.label + "|" + count + "|" + (flagged ? 1 : 0) + "|" + (pathOn ? 1 : 0) + "|" + v.tip;
      if (s.sig === sig) return;
      s.sig = sig;
      s.li.className = "lv-step lv-" + v.state; s.li.setAttribute("data-state", v.state);
      if (v.tip) s.li.title = v.tip; else s.li.removeAttribute("title");
      s.link.className = "lv-link" + (v.state === "running" ? " lv-energy" : "") + (v.state !== "idle" ? " lv-walked" : "") + (pathOn ? " lv-pathon" : "");
      var ic = ICON[v.state];
      s.icoPath.setAttribute("d", ic ? ic[0] : ""); s.ico.setAttribute("class", "lv-ico" + (ic && ic[1] ? " lv-fill" : ""));
      s.badge.hidden = !count; s.badge.textContent = count ? String(count) : "";
      s.flag.hidden = !flagged;
      s.st.textContent = v.label;
      s.sr.textContent = (v.label ? "" : SR[v.state]) + (count ? ", " + plural(count, "execução nesta etapa", "execuções nesta etapa") : "") + (flagged ? ", há execução com falha nesta etapa" : "");
    }
    function runButton(r, id) {
      var b = { li: el("li"), btn: el("button", "lv-run"), sig: "" };
      b.btn.type = "button"; b.btn.setAttribute("data-run", id); b.btn.setAttribute("aria-pressed", "false");
      b.fmt = el("span", "lv-tag"); b.sim = el("span", "lv-tag lv-simtag", "simulação"); b.title = el("b", "lv-t"); b.st = el("span", "lv-m lv-rs"); b.tm = el("span", "lv-m");
      [b.fmt, b.sim, b.title, b.st, b.tm].forEach(function (n) { b.btn.appendChild(n); });
      // Clique ou Enter: destaca o caminho desta execucao e avisa a pagina. O foco do teclado so mostra o caminho.
      // Nao ha destaque ao passar o mouse: a lista muda de altura sozinha e uma execucao pode parar debaixo do ponteiro.
      b.btn.addEventListener("click", function () {
        r.selected = id; renderRow(r, null);
        if (typeof opts.onRun === "function") { try { opts.onRun(id); } catch (e) { if (window.console) console.error(e); } }
      });
      b.btn.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && r.selected) { r.selected = null; renderRow(r, null); } });
      var peek = function (v) { return function () { if (r.preview !== v) { r.preview = v; renderRow(r, null); } }; };
      b.btn.addEventListener("focus", peek(id)); b.btn.addEventListener("blur", peek(null));
      b.li.appendChild(b.btn);
      return b;
    }
    function renderRuns(r, items) {
      var shown = items.slice(0, r.runsLimit), ids = [], keep = {}, focused = document.activeElement;
      shown.forEach(function (it) {
        var run = it.run, b = r.btns[run.id] || (r.btns[run.id] = runButton(r, run.id)), cur = it.path[it.cur], on = ACTIVE[run.status] === true;
        var status = on && cur ? cur.long : (RUN_END[run.status] || run.status);
        var started = ms(run.started_at), slot = ms(run.slot_at);
        var times = (started ? "iniciada " + stamp(started) : "") + (slot ? " · post para " + stamp(slot) : " · sem horário de agenda") + (run.revision > 0 ? " · versão " + (run.revision + 1) : "");
        var pressed = r.selected === run.id;
        var sig = [run.format, run.simulated ? 1 : 0, run.titulo || run.tema || "", run.step, status, times, pressed ? 1 : 0, run.status].join("|");
        ids.push(run.id); keep[run.id] = true;
        if (b.sig === sig) return;
        b.sig = sig;
        b.btn.className = "lv-run" + (run.status === "falhou" || (cur && cur.state === "failed") ? " lv-rfail" : "");
        b.btn.setAttribute("aria-pressed", pressed ? "true" : "false");
        b.fmt.textContent = FORMAT[run.format] || run.format || "Post";
        b.sim.hidden = run.simulated !== true;
        b.title.textContent = run.titulo || run.tema || "Tema ainda não definido";
        b.st.textContent = "Etapa: " + (STEP_LABEL[run.step] || run.step) + " · " + status;
        b.tm.textContent = times;
      });
      Object.keys(r.btns).forEach(function (id) { if (!keep[id]) { if (r.btns[id].li.parentNode) r.runs.removeChild(r.btns[id].li); delete r.btns[id]; } });
      if (ids.join(",") !== r.runOrder) {
        r.runOrder = ids.join(",");
        ids.forEach(function (id) { r.runs.appendChild(r.btns[id].li); });
        if (focused && focused !== document.activeElement && r.runs.contains(focused)) focused.focus();
      }
      hide(r.runs, !ids.length);
      hide(r.moreRuns, items.length <= shown.length);
      if (!r.moreRuns.hidden) put(r.moreRuns, "Mostrar mais " + plural(items.length - shown.length, "execução", "execuções"));
    }
    function renderFeed(r) {
      var total = ctx.countBy[r.id] || 0, i, ev, n = 0, frag, li, t, sig;
      if (!total) r.feedOpen = false;
      sig = (r.feedOpen ? "1|" : "0|") + total + "|" + r.feedLimit;
      if (r.sig.feedBtn !== sig) {
        r.sig.feedBtn = sig;
        hide(r.feedBtn, !total); put(r.feedBtn, r.feedOpen ? "Ocultar eventos" : "Ver eventos (" + total + ")");
        r.feedBtn.setAttribute("aria-expanded", r.feedOpen ? "true" : "false");
        hide(r.feed, !r.feedOpen); hide(r.moreFeed, !r.feedOpen || total <= r.feedLimit);
      }
      sig = r.feedOpen ? total + "|" + r.feedLimit + "|" + (ctx.lastBy[r.id] ? ctx.lastBy[r.id].id : 0) : "";
      if (r.sig.feed === sig) return;
      r.sig.feed = sig; r.feed.textContent = "";
      if (!r.feedOpen) return;
      frag = document.createDocumentFragment();
      for (i = events.length - 1; i >= 0 && n < r.feedLimit; i--) {
        ev = events[i]; if (ev.client_id !== r.id) continue;
        n++; t = ms(ev.created_at);
        li = el("li", "lv-ev" + (ev.status === "falhou" ? " lv-evfail" : "")); li.setAttribute("data-event", ev.id);
        li.appendChild(el("span", "lv-evt", t ? stamp(t, true) : ""));
        li.appendChild(el("span", "lv-evp", STEP_LABEL[ev.step] || ev.step));
        li.appendChild(el("span", "lv-evs", EV_STATUS[ev.status] || ev.status));
        li.appendChild(el("span", "lv-evm", ev.message + (ev.duration_ms != null ? " (" + took(ev.duration_ms) + ")" : "")));
        frag.appendChild(li);
      }
      r.feed.appendChild(frag);
    }
    // changes: quando informado, recebe as mudancas de estado do conjunto (para o aviso do leitor de tela).
    function renderRow(r, changes) {
      var a = r.agent, mine = ctx.runsBy[r.id] || [], items, track, active = 0, shown = null, agg = [], i, j, v, best, count, fail, sig, last, errs, t;
      items = mine.map(function (run) { return { run: run, path: runPath(run, ctx.idx[run.id]), cur: STEPS.indexOf(run.step), group: ACTIVE[run.status] === true ? 0 : run.status === "falhou" ? 1 : 2, t: ms(ACTIVE[run.status] === true ? run.started_at : run.updated_at) || 0 }; });
      items.sort(function (x, y) { return x.group - y.group || y.t - x.t; });
      track = items.filter(function (it) { return it.group < 2; });
      track.forEach(function (it) { if (it.group === 0) active++; });
      if (r.selected && !items.some(function (it) { return it.run.id === r.selected; })) r.selected = null;
      if (r.preview && !items.some(function (it) { return it.run.id === r.preview; })) r.preview = null;
      items.forEach(function (it) { if (it.run.id === (r.preview || r.selected)) shown = it; });

      // conjunto: estado de maior prioridade entre as execucoes em andamento e as que falharam
      for (i = 0; i < STEPS.length; i++) {
        best = view("idle"); count = 0; fail = false;
        for (j = 0; j < track.length; j++) {
          v = track[j].path[i];
          if (track[j].group === 0 && track[j].cur === i) count++;
          if (v.state === "failed") fail = true;
          if (v.rank > best.rank) best = v;
        }
        agg.push({ v: best, count: active >= 2 ? count : 0, flagged: fail && best.state !== "failed" });
        if (shown) applyStep(r.steps[i], shown.path[i], 0, false, i <= shown.cur);
        else applyStep(r.steps[i], best, agg[i].count, agg[i].flagged, false);
      }
      if (changes && r.prev) {
        for (i = 0; i < STEPS.length; i++) {
          v = agg[i].v;
          if ((v.state === "running" || v.state === "waiting" || v.state === "failed") && r.prev[i] !== v.state + "|" + v.label) changes.push(a.name + ": " + STEP_LABEL[STEPS[i]] + ", " + v.label);
        }
      }
      if (changes) r.prev = agg.map(function (x) { return x.v.state + "|" + x.v.label; });
      r.running = agg.filter(function (x) { return x.v.state === "running"; }).length; r.active = active;

      sig = a.name + "|" + a.is_demo + "|" + a.automation + "|" + active;
      if (r.sig.agent !== sig) {
        r.sig.agent = sig; r.root.setAttribute("aria-label", "Agente " + a.name);
        r.name.textContent = a.name; r.tags.textContent = "";
        if (a.is_demo) r.tags.appendChild(el("span", "lv-tag lv-demo", "demonstração"));
        r.tags.appendChild(el("span", "lv-tag " + (a.automation === "ligada" ? "lv-auto-on" : "lv-auto-off"), a.automation === "ligada" ? "automação ligada" : "automação pausada"));
        r.count.textContent = active ? plural(active, "post em produção", "posts em produção") : "nenhum post em produção";
      }

      last = ctx.lastBy[r.id] || null;
      sig = !gotData ? (offline === null ? "wait" : "nodata") : last ? "e" + last.id : items.length ? "runs" : "none";
      if (r.sig.last !== sig) {
        r.sig.last = sig; r.agoT = last ? ms(last.created_at) : null; r.agoText = ""; r.ago.textContent = "";
        r.msg.textContent = !gotData ? (offline === null ? "Carregando eventos..." : "Nenhum dado recebido ainda.") : last ? (STEP_LABEL[last.step] || last.step) + ": " + last.message : items.length ? "Sem evento recente desta conta." : "Sem atividade registrada.";
      }

      errs = track.filter(function (it) { return it.path[it.cur] && it.path[it.cur].state === "failed"; });
      sig = errs.map(function (it) { return it.run.id + ":" + it.path[it.cur].tip + ":" + it.path[it.cur].label; }).join("|");
      if (r.sig.errs !== sig) {
        r.sig.errs = sig; r.errs.textContent = ""; r.errs.hidden = !errs.length;
        errs.slice(0, 3).forEach(function (it) {
          v = it.path[it.cur];
          r.errs.appendChild(el("p", null, "Falhou em " + STEP_LABEL[it.run.step] + ": " + (sentence(v.tip) || "o motor não registrou o motivo.") + (v.note ? " " + v.note : "")));
        });
        if (errs.length > 3) r.errs.appendChild(el("p", null, "Mais " + plural(errs.length - 3, "execução com falha", "execuções com falha") + " na lista abaixo."));
      }

      hide(r.sel, !r.selected);
      renderRuns(r, items);
      renderFeed(r);
    }

    // ---------- desenho geral ----------
    function render() {
      var idx = {}, lastBy = {}, countBy = {}, runsBy = {}, i, ev, m, changes = speak ? [] : null, running = 0, active = 0;
      for (i = 0; i < events.length; i++) {
        ev = events[i];
        if (ev.run_id) { m = idx[ev.run_id] || (idx[ev.run_id] = { by: {}, last: null }); m.by[ev.step] = ev; m.last = ev; }
        lastBy[ev.client_id] = ev; countBy[ev.client_id] = (countBy[ev.client_id] || 0) + 1;
      }
      for (i = 0; i < runs.length; i++) (runsBy[runs[i].client_id] || (runsBy[runs[i].client_id] = [])).push(runs[i]);
      ctx = { idx: idx, lastBy: lastBy, countBy: countBy, runsBy: runsBy };
      order.forEach(function (id) { var r = rows[id]; renderRow(r, changes || (gotData ? [] : null)); running += r.running; active += r.active; });
      put(sum, !gotData ? "" : (active ? plural(active, "post em produção", "posts em produção") : "nenhum post em produção") + " · " + (running ? plural(running, "etapa rodando agora", "etapas rodando agora") : "nenhuma etapa rodando agora"));
      // Aviso para leitor de tela: so mudancas de estado, no maximo tres por consulta.
      if (changes && changes.length) notice += changes.slice(0, 3).join(". ") + (changes.length > 3 ? ". Mais " + plural(changes.length - 3, "mudança", "mudanças") + "." : ".");
      if (notice) { say.textContent = notice.trim(); notice = ""; }
      tick();
    }

    // Cabecalho, aviso de dado velho e tempos relativos. Roda a cada segundo, sem ler layout.
    function tick() {
      var now = Date.now(), age = gotData ? now - lastOk : 0, next, a, late, text, wait;
      next = stopped ? "stopped" : offline ? "offline" : !gotData ? "loading" : age > STALE_MS ? "stale" : "live";
      if (next !== mode) {
        mode = next; setClass();
        conn.textContent = { live: "Ao vivo", loading: "Carregando", stale: "Sem atualização", offline: "Sem conexão", stopped: "Parado" }[mode];
      }
      text = gotData ? "atualizado " + ago(age) : mode === "loading" ? "buscando os eventos" : "nenhum dado recebido ainda";
      put(upd, text); hide(sum, mode !== "live");
      if (mode === "offline") { wait = Math.max(0, Math.ceil((retryAt - now) / 1000)); text = "Sem conexão com o servidor. " + sentence(offline) + (inflight ? " Tentando de novo agora." : " Nova tentativa em " + wait + " s."); }
      else if (mode === "stale") text = "Sem atualização " + ago(age) + ". O painel mostra o último estado recebido, com a animação parada.";
      else if (mode === "stopped") text = "Atualização parada. O painel mostra o último estado recebido.";
      else text = "";
      put(bannerText, text); hide(banner, !text); hide(retryBtn, mode === "stopped");
      text = ""; late = false;
      if (gotData) {
        a = sched && ms(sched.at);
        if (!a) text = "Motor: nenhum ciclo registrado ainda.";
        else {
          late = now + offset - a > SCHED_LATE_MS;
          text = late ? "Motor sem ciclo " + ago(now + offset - a) + " (o esperado é um por minuto)" : "Motor: último ciclo " + ago(now + offset - a);
          if (!late && typeof sched.steps === "number") text += ", " + plural(sched.steps, "etapa", "etapas") + (sched.created ? ", " + plural(sched.created, "execução criada", "execuções criadas") : "");
          if (Array.isArray(sched.errors) && sched.errors.length) { late = true; text += ". " + plural(sched.errors.length, "erro", "erros") + " no ciclo: " + String(sched.errors[0]).slice(0, 160); }
        }
      }
      put(schedEl, text);
      if (late !== schedLate) { schedLate = late; schedEl.className = "lv-sched" + (late ? " lv-warn" : ""); }
      order.forEach(function (id) {
        var r = rows[id], t = r.agoT ? ago(now + offset - r.agoT) : "";
        if (t !== r.agoText) { r.agoText = t; r.ago.textContent = t; }
      });
    }
    function setClass() { root.className = "lv-root lv-m-" + (mode || "loading") + (mode === "live" ? "" : " lv-frozen") + (narrow ? " lv-narrow" : ""); }
    function measure() {
      var w = root.clientWidth || window.innerWidth || 1024, n = w < NARROW_PX;
      if (n === narrow) return;
      narrow = n; setClass(); order.forEach(function (id) { orient(rows[id]); });
    }

    // ---------- pulso: um por evento "ok" novo (ver cabecalho) ----------
    function oneShot(parent, cls, counter) {
      var n = el("span", cls), gone = false;
      var rm = function () { if (gone) return; gone = true; if (n.parentNode) n.parentNode.removeChild(n); };
      n.addEventListener("animationend", rm); setTimeout(rm, 1600);
      parent.setAttribute(counter, String((Number(parent.getAttribute(counter)) || 0) + 1));
      parent.appendChild(n);
    }
    function pulse(ev) {
      var r = rows[ev.client_id], i = STEPS.indexOf(ev.step), run = null, k;
      if (!r || i < 0 || (motion && motion.matches)) return;
      for (k = 0; k < runs.length; k++) if (runs[k].id === ev.run_id) run = runs[k];
      if (i < STEPS.length - 1 && run && STEPS.indexOf(run.step) > i) oneShot(r.steps[i + 1].link, "lv-pulse", "data-pulses");
      else oneShot(r.steps[i].node, "lv-ripple", "data-ripples");
    }

    // ---------- dados ----------
    function onData(resp, wasBaseline) {
      if (!resp || typeof resp !== "object" || !Array.isArray(resp.events) || !Array.isArray(resp.runs)) throw new Error("Resposta inesperada do servidor.");
      var now = ms(resp.now), fresh = [], i, ev, id, unsorted = false, top = events.length ? events[events.length - 1].id : 0, wasOffline = offline !== null;
      if (now) offset = now - Date.now();
      for (i = 0; i < resp.events.length; i++) {
        ev = resp.events[i]; id = ev ? Number(ev.id) : NaN;
        if (!isFinite(id) || !ev.client_id || seen[id]) continue;
        ev = { id: id, run_id: ev.run_id || null, client_id: String(ev.client_id), step: String(ev.step || ""), status: String(ev.status || ""), message: String(ev.message || ""), duration_ms: typeof ev.duration_ms === "number" ? ev.duration_ms : null, created_at: ev.created_at };
        seen[id] = true; events.push(ev); fresh.push(ev);
        if (ev.id < top) unsorted = true; else top = ev.id;
      }
      if (unsorted) events.sort(function (x, y) { return x.id - y.id; });
      while (events.length > MAX_EVENTS) delete seen[events.shift().id];
      cursor = Math.max(cursor, Number(resp.cursor) || 0, top);
      runs = resp.runs; sched = resp.agents_last_run || null;
      gotData = true; baseline = false; lastOk = Date.now(); fails = 0; offline = null;
      if (wasOffline) notice = "Conexão com o servidor retomada. ";
      render();
      speak = true;
      if (wasBaseline) return;
      for (i = 0; i < fresh.length; i++) {
        ev = fresh[i];
        if (ev.status === "ok" && ev.run_id && Date.now() + offset - (ms(ev.created_at) || 0) <= freshMs) pulse(ev);
      }
    }
    function onFail(e) {
      var first = offline === null;
      fails++; offline = (e && e.message) || "Não foi possível buscar os dados.";
      retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, interval * Math.pow(2, fails));
      if (first) notice = "Sem conexão com o servidor. A animação foi parada.";
      render();
    }
    function schedule(wait) {
      clearTimeout(pollTimer); pollTimer = null;
      if (stopped || document.hidden) return;
      pollTimer = setTimeout(poll, wait);
    }
    function poll() {
      if (stopped || document.hidden) return;
      if (inflight) { again = true; return; }
      inflight = true; clearTimeout(pollTimer); pollTimer = null;
      var mine = ++seq, settled = false, wasBaseline = baseline, p;
      var finish = function (err, resp) {
        if (settled) return;
        settled = true; clearTimeout(guardTimer);
        if (mine !== seq) return;
        inflight = false;
        if (stopped) return;
        if (!err) { try { onData(resp, wasBaseline); } catch (e) { err = e; } }
        if (err) onFail(err);
        if (again) { again = false; schedule(0); } else schedule(err ? Math.max(0, retryAt - Date.now()) : interval);
      };
      guardTimer = setTimeout(function () { finish(new Error("O servidor demorou para responder.")); }, timeoutMs);
      try { p = load(wasBaseline ? 0 : cursor, only); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (resp) { finish(null, resp); }, function (e) { finish(e || new Error("Não foi possível buscar os dados.")); });
      if (offline !== null) tick();
    }
    function refresh() {
      if (stopped) return;
      if (inflight) { again = true; return; }
      poll();
    }
    // Aba escondida: nenhuma consulta. Ao voltar, consulta na hora; depois de muito tempo fora, recomeca da carga inicial.
    function onVisibility() {
      if (stopped) return;
      if (document.hidden) { hiddenAt = Date.now(); clearTimeout(pollTimer); pollTimer = null; clearInterval(tickTimer); tickTimer = null; return; }
      if (hiddenAt && Date.now() - hiddenAt > HIDDEN_RESET_MS) baseline = true;
      hiddenAt = 0;
      if (!tickTimer) tickTimer = setInterval(tick, 1000);
      tick(); poll();
    }
    function stop() {
      if (stopped) return;
      stopped = true; seq++;
      clearTimeout(pollTimer); clearTimeout(guardTimer); clearInterval(tickTimer); pollTimer = guardTimer = tickTimer = null;
      document.removeEventListener("visibilitychange", onVisibility);
      if (observer) observer.disconnect(); else window.removeEventListener("resize", measure);
      if (container.__srpLive === api) delete container.__srpLive;
      tick();
    }
    function setAgents(listIn) { agents = normalize(listIn); syncRows(); render(); }

    var api = { stop: stop, refresh: refresh, setAgents: setAgents };
    container.__srpLive = api;
    agents = normalize(opts.agents); syncRows(); measure(); render();
    if (window.ResizeObserver) { observer = new ResizeObserver(measure); observer.observe(root); } else window.addEventListener("resize", measure);
    document.addEventListener("visibilitychange", onVisibility);
    if (document.hidden) hiddenAt = Date.now(); else { tickTimer = setInterval(tick, 1000); poll(); }
    return api;
  }

  window.SrpLive = { mount: mount };
})();
