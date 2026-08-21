# QSND

Interface temporária para trocar textos e arquivos dentro de uma sala. Nada sobrevive ao encerramento da sala.

## Objetivo do MVP

Uma pessoa cria uma sala, informa seu nome e recebe um código curto. Outras pessoas entram com esse código e seus nomes. Enquanto a sala existir, todos veem os participantes, as mensagens e os arquivos disponíveis.

O produto não terá contas, banco de dados, histórico, busca, moderação ou armazenamento permanente.

## Decisões iniciais

- Hospedagem principal: **Azure Web App**, em uma única instância.
- Entrada: **código da sala + nome**.
- Código: cinco letras maiúsculas, sem caracteres visualmente ambíguos.
- Nome da sala: opcional; o código é sempre gerado pelo servidor.
- Arquivos: até **100 MB no total por sala** e até 20 arquivos.
- Dono desconectado: a sala aguarda **5 minutos** por uma reconexão.
- Inatividade: a sala expira após **30 minutos sem ação**.
- Sem persistência: mensagens e presença ficam em memória; arquivos ficam criptografados apenas no diretório temporário do processo.

## Experiência

### Criar uma sala

1. Informar o nome de exibição e, opcionalmente, um nome para a sala.
2. Criar a sala.
3. Receber o código e um botão para copiá-lo.
4. Entrar como dono com um avatar emoji temporário.

### Entrar em uma sala

1. Informar o código e o nome de exibição.
2. Receber um avatar emoji temporário.
3. Ver o conteúdo atual da sala e quem está conectado.

O código funciona como o segredo de acesso. Não há descoberta ou listagem pública de salas.

### Dentro da sala

- Feed único, em ordem cronológica, com blocos de texto em Markdown e cartões de arquivo.
- Markdown mínimo: parágrafos, ênfase, negrito, links, listas, citações e código inline ou em bloco.
- Cada bloco oferece `Copiar formatado` e `Copiar Markdown`. A cópia formatada inclui HTML e uma versão em texto simples para aplicativos sem suporte a conteúdo rico.
- Envio de vários arquivos em uma seleção; cada arquivo é baixado individualmente.
- Lista de participantes com avatar, nome e estado `visualizando` ou `em segundo plano`.
- Código, nome da sala, tempo restante e ação de copiar convite no cabeçalho.
- Ação exclusiva do dono para encerrar a sala imediatamente.
- Aviso visível quando faltarem cinco minutos para expirar por inatividade.
- Contagem regressiva para todos quando o dono estiver desconectado.

### Direção visual

Uma “mesa de transferência” compacta: fundo claro e quente, superfícies com contraste nítido, tipografia editorial e uma cor de sinalização forte para ações e estados. Sem aparência de painel administrativo.

No desktop, o feed ocupa o centro e a presença fica em uma coluna estreita. No celular, a presença vira uma gaveta e o compositor permanece acessível no rodapé. Movimento deve comunicar entrada, upload e expiração, sem animações decorativas excessivas.

## Ciclo de vida

A sala possui três estados:

- `active`: aceita participantes, textos, uploads e downloads.
- `owner-away`: bloqueia mensagens e transferências, aborta as que estiverem ativas e aguarda a volta do dono por até 5 minutos.
- `destroyed`: rejeita qualquer acesso e remove todo o conteúdo.

A sala é destruída quando ocorrer primeiro:

1. o dono solicitar o encerramento;
2. o dono não reconectar em 5 minutos;
3. ninguém realizar uma ação por 30 minutos;
4. o processo for reiniciado ou encerrado.

Ações que renovam o prazo de inatividade: entrar, enviar texto, concluir upload e iniciar download. Heartbeats de conexão e uma aba apenas aberta não renovam o prazo.

O navegador guarda o token de retomada do dono somente em `sessionStorage`. Assim, atualizar a página permite retomar a sala, mas o token não vira uma conta ou sessão permanente.

Ao destruir uma sala, o servidor:

1. avisa os clientes conectados;
2. invalida os tokens temporários;
3. remove o estado da memória;
4. apaga recursivamente o diretório de arquivos da sala.

Na inicialização, o servidor também limpa o diretório temporário do QSND para remover sobras de uma interrupção abrupta.

## Arquitetura mínima

```text
Navegador
  ├─ HTTP: página, criação/entrada, upload e download
  └─ WebSocket: mensagens, presença, progresso e encerramento
                      │
                      ▼
         Azure Web App — 1 processo Node.js
           ├─ Map em memória: salas e participantes
           └─ diretório temporário: arquivos
```

### Implementação proposta

- Node.js com um único servidor HTTP.
- HTML, CSS e JavaScript do navegador, sem framework ou etapa de build.
- Duas dependências de runtime: `ws`, para WebSocket no servidor, e `markdown-it`, para renderização segura e consistente do Markdown no servidor.
- `crypto`, `fs`, `http`, `path` e `node:test` da biblioteca padrão.
- Upload transmitido diretamente para disco temporário, sem carregar o arquivo inteiro em memória.
- Cada arquivo é gravado com AES-256-GCM e uma chave aleatória mantida somente na memória da sala.
- Arquivos identificados internamente por IDs aleatórios; o nome original é apenas metadado de exibição.
- Uma única instância do Azure Web App. Escala horizontal não faz parte do MVP porque o estado é local ao processo.

Vercel não é o alvo inicial: funções efêmeras exigiriam um serviço externo de tempo real e outro de arquivos, contrariando a proposta pequena e sem persistência.

## Dados mantidos durante a sala

```text
Room
- code
- optional label
- owner resume token
- status
- createdAt / lastActivityAt / ownerDisconnectedAt
- participants
- timeline entries
- totalFileBytes

Participant
- temporary token
- display name
- emoji
- role: owner | guest
- visibility: viewing | background

Timeline entry
- text: id, author, markdown, createdAt
- file: id, author, original name, byte size, createdAt
```

Não serão gravados payloads, nomes, códigos ou nomes de arquivo em logs da aplicação.

## Limites e proteção

- 50 salas simultâneas no processo.
- 10 participantes simultâneos e 20 sessões temporárias por sala.
- Nome de exibição: 1–24 caracteres.
- Texto: até 8.000 caracteres por envio; blocos acima de 280 px ficam recolhidos até a pessoa expandi-los.
- Arquivo individual: até 100 MB.
- Sala: até 20 arquivos, três uploads simultâneos e 100 MB somados.
- Servidor: até 400 MB de arquivos temporários somados.
- O servidor guarda somente o Markdown original durante a vida da sala.
- HTML escrito pelo usuário fica desabilitado; apenas o HTML produzido pelo renderizador de Markdown entra na página.
- Links usam protocolos seguros e abrem sem acesso à página de origem.
- `Copiar formatado` usa a Clipboard API com `text/html` e `text/plain`; sem suporte, copia somente o texto renderizado.
- `Copiar Markdown` copia exatamente a fonte original como texto simples.
- Download sempre com `Content-Disposition: attachment`.
- Nome de arquivo nunca é usado como caminho no servidor.
- Upload e download exigem um token de participante atualmente conectado.
- Transferências ativas são abortadas quando a sala é encerrada.
- Códigos e IDs não aparecem nas URLs de arquivo.
- Tentativas de entrada, conexões e eventos possuem rate limiting em memória.
- Comparação de códigos não diferencia sala inexistente, pausada ou token inválido.

O código curto é adequado para troca casual e temporária, não para material altamente sensível. Senha, autenticação corporativa e trilha de auditoria ficam fora do MVP. Consulte [`SECURITY.md`](SECURITY.md) para garantias, configuração e riscos residuais.

## Executar

Requer Node.js 22 ou superior.

```bash
npm install
npm start
```

A aplicação estará em `http://localhost:3000`; `GET /health` verifica a disponibilidade. Para desenvolvimento com reinício automático, use `npm run dev`.

No Azure Web App:

- use o runtime Node.js 22 ou mais recente; o F1 atende ao MVP com cold start, enquanto B1+ é recomendado para operação previsível;
- use `npm start` como comando de inicialização;
- habilite HTTPS Only, TLS 1.2+ no site e no SCM e WebSockets;
- configure `PUBLIC_ORIGIN=https://<host-público-exato>`;
- mantenha somente uma instância;
- não habilite armazenamento persistente para os arquivos temporários;
- não capture corpos ou cabeçalhos sensíveis em logs e telemetria.

Reinícios e trocas de instância encerram todas as salas por definição.

## Plano de entrega

### 1. Sala e tempo real

- Criar e entrar em uma sala.
- Gerar códigos e avatares.
- Mostrar presença e estado da aba.
- Enviar Markdown, renderizar o subconjunto definido e sincronizar o feed.
- Copiar cada bloco como conteúdo formatado ou fonte Markdown.
- Implementar encerramento, reconexão do dono e expiração.
- Cobrir a máquina de estados e os casos de Markdown inseguro com `node:test`.

### 2. Arquivos

- Fazer upload em streaming com os limites definidos.
- Publicar metadados no feed.
- Autorizar e transmitir downloads.
- Apagar os arquivos em todos os caminhos de encerramento.
- Testar limite agregado, nome hostil e acesso após expiração.

### 3. Interface e implantação

- Aplicar o layout responsivo e os estados de erro/progresso.
- Validar teclado, foco, contraste e leitores de tela.
- Implantar uma única instância no Azure Web App com WebSockets habilitados.
- Fazer um teste com dois navegadores e confirmar a limpeza após cada forma de encerramento.

## Critérios de aceite do MVP

- Duas pessoas em navegadores distintos trocam textos em Markdown renderizado em tempo real.
- Cada bloco pode ser copiado como conteúdo formatado ou como a fonte Markdown original.
- HTML e links inseguros enviados por um participante não são executados.
- Ambas veem corretamente entrada, saída, nome, emoji e estado de visualização.
- Uma seleção de arquivos aparece para todos e pode ser baixada enquanto a sala estiver ativa.
- Um novo participante recebe o conteúdo ainda ativo da sala.
- O dono consegue atualizar a página e retomar a sala em menos de 5 minutos.
- A sala é apagada por ação do dono, ausência do dono, inatividade ou reinício.
- Depois da exclusão, códigos, tokens e URLs antigas não dão acesso a mensagens ou arquivos.
- Nenhum dado funcional da sala é persistido ou incluído nos logs da aplicação.

## Fora do MVP

Contas, histórico, banco de dados, armazenamento em Blob, criptografia ponta a ponta, miniaturas, antivírus, ZIP para “baixar tudo”, edição de mensagens, notificações, escala horizontal e suporte específico à Vercel.

## Licença

[MIT](LICENSE).
