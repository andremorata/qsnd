# Segurança e ciclo de vida dos dados

[Português do Brasil](SECURITY.md) · [English (US)](SECURITY.en-US.md)

O QSND foi desenhado para troca casual e temporária. Este documento define o que a aplicação garante, o que depende da implantação e o que ela não promete.

## Modelo de acesso

- O código de cinco letras permite solicitar entrada na sala.
- Depois da entrada, o servidor emite um token aleatório de 192 bits para aquele participante.
- Mensagens, presença, uploads e downloads exigem uma conexão autenticada e ativa.
- O token fica apenas na memória do servidor e no `sessionStorage` daquela aba. Ele não aparece em URLs.
- Idioma e tema podem ficar em `localStorage`; essas preferências não contêm código, token nem conteúdo da sala.
- O servidor não lista salas e devolve a mesma resposta para sala inexistente, pausada ou token inválido.
- Tentativas de conexão, criação, entrada, retomada, eventos e transferências são limitadas por endereço de origem.
- WebSockets aceitam apenas a origem pública configurada e fecham conexões que não se autenticam em dez segundos.

O código curto continua sendo um segredo de baixa entropia. Os limites tornam varredura casual impraticável durante os 30 minutos de vida da sala, mas não substituem senha ou identidade corporativa contra um atacante distribuído.

## Dados durante a sessão

### Mensagens

- Permanecem somente na memória do processo.
- O servidor guarda o Markdown original e gera HTML com `markdown-it`.
- HTML e imagens enviados pelo usuário ficam desabilitados.
- Links perigosos são rejeitados; links válidos recebem `noopener noreferrer`.
- Nomes, títulos e nomes de arquivo entram na interface por `textContent`, não por HTML.

### Arquivos

- O upload é transmitido, sem carregar o arquivo completo em memória.
- Cada arquivo recebe uma chave aleatória própria e é gravado com AES-256-GCM.
- A chave, o vetor de inicialização e a tag de autenticação existem somente na memória da sala.
- O disco temporário contém apenas ciphertext; um arquivo residual após falha não é utilizável sem a chave perdida.
- Diretórios usam permissão `0700`; arquivos usam `0600`.
- Downloads exigem o token conectado e são enviados como `application/octet-stream`, `attachment` e `nosniff`.
- O nome original nunca é usado como caminho físico.

A criptografia é feita no servidor, não de ponta a ponta. O servidor e todos os participantes autorizados veem o conteúdo em claro durante o uso.

## Encerramento da sala

O encerramento ocorre por ação do dono, ausência do dono por cinco minutos, 30 minutos sem atividade ou parada do processo. Assim que detecta a desconexão do dono, o servidor já bloqueia novas mensagens e transferências e aborta transferências ativas; uma reconexão válida reabre a sala durante a tolerância de cinco minutos.

Ao encerrar, nesta ordem, o servidor:

1. zera em memória as chaves, IVs e tags dos arquivos;
2. remove a sala do mapa de autorização, invalidando códigos e tokens no mesmo turno do processo;
3. aborta uploads e downloads ainda ativos;
4. avisa e fecha os WebSockets;
5. remove o diretório da sala, com novas tentativas em caso de falha.

Na inicialização, o processo apaga e recria toda a raiz temporária antes de aceitar tráfego. No desligamento normal, aguarda transferências abortadas e remoções pendentes.

A invalidação de acesso é imediata. A remoção física pelo sistema operacional ocorre de forma assíncrona e não equivale a sobrescrever blocos de SSD. A criptografia por arquivo garante que resíduos de disco não possam ser descriptografados depois que a chave em memória é destruída.

Strings de mensagens são removidas das estruturas da aplicação, mas o JavaScript não oferece apagamento seguro da memória gerenciada. A coleta física da memória fica a cargo do runtime e do sistema operacional.

## Limites contra abuso

- 50 salas simultâneas.
- 10 participantes conectados e 20 sessões retidas por sala.
- 500 itens de timeline por sala.
- 8.000 caracteres por mensagem.
- 20 arquivos, 100 MB e três uploads simultâneos por sala.
- 400 MB de arquivos somados no processo.
- 200 WebSockets e 100 transferências HTTP simultâneas no processo.
- Cinco criações e 12 tentativas de entrada por minuto e por endereço.
- 120 eventos ou requisições de arquivo por minuto por sessão/endereço.

Esses controles protegem uma instância pequena contra abuso simples. Um ataque distribuído exige proteção externa, como Azure Front Door/WAF e regras de rate limiting na borda.

## Logs e cache

A aplicação não registra códigos, tokens, nomes, mensagens, nomes de arquivo ou conteúdo. Os endpoints HTTP de arquivo não carregam código ou ID na URL; esses valores seguem em cabeçalhos não registrados pela aplicação.

Todas as respostas funcionais usam `Cache-Control: no-store`. A página também envia CSP restrita, HSTS, `X-Frame-Options: DENY`, `nosniff`, política de referência e `Permissions-Policy`.

Azure, proxy, WAF e ferramentas de observabilidade ainda podem produzir metadados operacionais como IP, horário, rota fixa, status e volume transferido. Não habilite captura de corpo ou cabeçalhos de autorização. Defina retenção mínima e acesso restrito para logs de infraestrutura.

## Configuração obrigatória no Azure Container Apps

- No máximo uma réplica (`--max-replicas 1`). Escala a zero é aceita: a réplica só é desligada sem requisições nem WebSockets abertos.
- Ingress externo com tráfego HTTP inseguro desabilitado. O ambiente aceita somente TLS 1.2 ou superior.
- `PUBLIC_ORIGIN=https://<host-público-exato>` configurado.
- `TRUST_PROXY=1`, já definido no `Dockerfile`, para usar o IP e o protocolo repassados pelo ingress.
- Sem volume persistente no diretório temporário.
- Imagem obtida do registro por identidade gerenciada com `AcrPull`, sem senha de registro.
- Logs do console sem corpos, cabeçalhos e dados pessoais.
- Telemetria opcional do Application Insights (`src/telemetry.js`): envia rota conhecida ou `/{other}`, status, duração, eventos da sala com contagens e bytes, e o IP para geolocalização. A ingestão grava o IP mascarado como `0.0.0.0`. Nunca envia código da sala, token, nomes, nomes de arquivo, query string ou conteúdo.

Reinício, nova revisão, escala a zero ou troca de réplica encerram todas as salas. Isso é comportamento de segurança, não recuperação de desastre.

Referências da plataforma:

- [Ingress no Azure Container Apps](https://learn.microsoft.com/azure/container-apps/ingress-overview)
- [Armazenamento no Azure Container Apps](https://learn.microsoft.com/azure/container-apps/storage-mounts)
- [Escala no Azure Container Apps](https://learn.microsoft.com/azure/container-apps/scale-app)

## Riscos residuais

- Quem conhece o código pode entrar e copiar tudo enquanto a sala estiver ativa.
- Um participante autorizado pode salvar, fotografar ou reenviar conteúdo; o encerramento não apaga cópias externas.
- Não há criptografia ponta a ponta, senha de sala, autenticação de identidade, antivírus ou prevenção contra phishing.
- Um processo comprometido pode ler mensagens, tokens e chaves enquanto a sala está ativa.
- Rate limiting em memória reinicia com o processo e não bloqueia um ataque distribuído.
- Uma perda silenciosa de rede pode levar até cerca de 30 segundos para ser detectada pelos heartbeats; os cinco minutos de tolerância começam depois dessa detecção.
- Arquivos baixados ficam sujeitos às políticas e ao armazenamento do dispositivo de quem baixou.

Não use o MVP para segredos de alto impacto, dados regulados ou conteúdo cuja divulgação gere dano relevante. Para esse nível, adicione identidade forte, convite de alta entropia, criptografia ponta a ponta, proteção de borda e política formal de retenção.

## Verificação antes de publicar

```bash
npm test
npm audit --omit=dev
```

Depois da implantação, confirme manualmente:

1. HTTP redireciona para HTTPS e TLS antigo é recusado.
2. Origem diferente não consegue abrir `/ws`.
3. Upload e download funcionam somente para participante conectado.
4. Encerrar a sala interrompe transferências e URLs antigas retornam indisponível.
5. O diretório temporário não contém plaintext e desaparece após o encerramento.
6. Logs do Azure não contêm payloads, códigos, tokens ou nomes de arquivo.
