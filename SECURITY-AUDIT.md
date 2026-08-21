# Auditoria de segurança

## Escopo

Revisão do fluxo completo de criação, entrada, mensagens, Markdown, presença, upload, armazenamento temporário, download, reconexão, encerramento e reinício. Foram inspecionados código do servidor e navegador, testes, dependências e requisitos do Azure Web App. Uma segunda revisão independente foi executada antes das correções.

## Resultado

| ID | Severidade inicial | Achado | Tratamento | Estado |
|---|---:|---|---|---|
| F-01 | Alta | Código curto permitia enumeração sem limitação e erros revelavam salas existentes. | Uma tentativa por WebSocket, respostas indistinguíveis, limites por endereço e globais. | Mitigado; código curto permanece inadequado para conteúdo altamente sensível. |
| F-02 | Alta | Salas, disco, conexões e eventos não tinham orçamento global. | Tetos globais e por sala para salas, bytes, uploads, transferências, WebSockets e eventos. | Corrigido. |
| F-03 | Alta condicional | HTTPS e TLS dependiam apenas da futura configuração do Azure. | HSTS e documentação obrigatória de HTTPS Only, TLS 1.2+ e `PUBLIC_ORIGIN`. | Pendente de verificação depois da implantação. |
| F-04 | Média | Um convidado desconectado podia usar `resume` acima do limite da sala. | Capacidade revalidada na retomada e limite de sessões retidas. | Corrigido. |
| F-05 | Média | WebSocket aceitava qualquer `Origin` e sockets anônimos permaneciam abertos. | Origem exata obrigatória e timeout de autenticação de dez segundos. | Corrigido. |
| F-06 | Média | Upload ou download iniciado podia continuar depois do encerramento. | Streams rastreados e abortados ao desconectar o dono ou destruir a sala. | Corrigido. |
| F-07 | Média | Código da sala aparecia nas rotas HTTP e poderia chegar a logs de acesso. | Endpoints fixos; código e ID seguem em cabeçalhos autorizados. | Corrigido na aplicação; retenção de logs da plataforma ainda deve ser configurada. |
| F-08 | Baixa | CSP permitia conexão com qualquer destino `ws:` ou `wss:`. | `connect-src` limitado ao WebSocket exato da origem pública; políticas adicionais aplicadas. | Corrigido. |
| F-09 | Alta | Arquivos temporários eram gravados em claro e `rm` não garante sobrescrita física. | AES-256-GCM por arquivo, chaves apenas em memória, permissões `0700/0600`, limpeza com retry e limpeza de startup. | Corrigido para confidencialidade de resíduos de disco. |

## Controles confirmados

- Tokens de participante usam 192 bits aleatórios e não aparecem em URLs.
- Operações de arquivo exigem token de participante conectado.
- Somente o dono encerra a sala.
- HTML e imagens de Markdown ficam desabilitados; protocolos ativos inseguros são rejeitados.
- Conteúdo não confiável de nomes e metadados entra no DOM como texto.
- Nome de arquivo nunca determina caminho físico.
- Download usa `attachment`, tipo binário, `nosniff` e `no-store`.
- Chaves de arquivo são zeradas e referências da sala são removidas no encerramento.
- Transferências são bloqueadas já no estado `owner-away`.
- Reinício limpa a raiz temporária antes de aceitar tráfego.
- A aplicação não contém segredos estáticos nem registra payloads ou identificadores funcionais.
- Dependências estão bloqueadas por integridade no `package-lock.json`.

## Evidência executável

O gate local cobre:

- máquina de estados e retomada do dono;
- limite de participantes, salas, bytes e uploads concorrentes;
- Markdown inseguro (`script`, `javascript:`, `data:`, `vbscript:` e imagem remota);
- WebSocket de origem indevida;
- timeout de socket não autenticado;
- resposta indistinguível para sala inexistente;
- mensagem de 8.000 caracteres pelo transporte real;
- arquivo diferente do plaintext no disco e permissões restritas;
- download descriptografado somente com sessão ativa;
- interrupção de transferência e remoção do diretório;
- indisponibilidade depois do encerramento;
- CSP e cabeçalhos principais.

Comandos do gate:

```bash
npm test
npm audit --omit=dev
```

## Riscos residuais

Os riscos aceitos e as condições operacionais estão detalhados em [`SECURITY.md`](SECURITY.md). Os principais são:

1. o código curto continua sendo um segredo compartilhado de baixa entropia;
2. não há criptografia ponta a ponta: o servidor vê o conteúdo durante a sessão;
3. participantes autorizados podem manter cópias externas;
4. não há antivírus, identidade forte ou proteção contra phishing;
5. rate limiting em memória não detém ataque distribuído;
6. strings em memória gerenciada não podem ser sobrescritas de forma garantida;
7. logs e configurações do Azure precisam ser verificados no ambiente real.

## Decisão

**Código local: pronto após as correções e o gate automatizado.**

**Operação pública: pronta somente depois de validar o checklist Azure de `SECURITY.md`.** Para tráfego não confiável em escala, adicionar proteção de borda com WAF/rate limiting distribuído. Para dados de alto impacto ou regulados, o modelo de código curto deve ser substituído por identidade forte ou convite de alta entropia e criptografia ponta a ponta.
