# PontoLink — publicação no Railway

Sistema de controle de ponto com PIN, foto e reconhecimento facial. O projeto roda em um único serviço Node.js e utiliza SQLite. O banco e as fotos devem ficar em um **Volume persistente** do Railway.

## Estrutura do projeto

- `server.js`: servidor Express e rotas da aplicação.
- `public/index.html`: tela principal.
- `public/espelho.html`: tela de espelho/consulta.
- `package.json`: dependências e Node.js 22.
- `nixpacks.toml`: ferramentas necessárias para compilar dependências nativas, como `better-sqlite3`.
- `railway.json`: configuração de build e healthcheck.

## Publicar no Railway

1. Extraia o ZIP e envie **o conteúdo da pasta** para a raiz de um repositório GitHub.
2. No Railway, crie um projeto usando **Deploy from GitHub Repo** e selecione o repositório.
3. No serviço, crie um **Volume** com Mount Path exatamente `/data`.
4. Em **Variables**, configure:
   - `NODE_ENV=production`
   - `DATA_DIR=/data`
   - `ADMIN_PIN`: PIN inicial numérico, com 8 a 12 dígitos.
   - `FACE_THRESHOLD=0.5` (opcional; valor padrão 0.5).
5. Aguarde o deploy. O healthcheck configurado em `/health` deve retornar HTTP 200.
6. Gere/ative o domínio público do serviço e abra o endereço no navegador.

O `package.json` fixa o projeto na linha Node.js 22. O `nixpacks.toml` instala Python 3, GCC e Make para permitir a compilação do `better-sqlite3` quando não houver binário pré-compilado compatível.

## Primeiro uso

1. No celular da loja, abra o endereço público do Railway.
2. Autorize o aparelho usando o PIN do gestor e dê um nome ao dispositivo.
3. Na aba Gestor, cadastre os funcionários e o rosto de cada um.
4. Em Aparelhos autorizados, é possível revogar um celular perdido ou substituído.

## Persistência e backup — importante

O Volume montado em `/data` armazena `ponto.db` e a pasta `photos/`. **Não remova nem recrie o Volume** depois de começar a usar o sistema. Sem o Volume e a variável `DATA_DIR=/data`, os dados podem ser perdidos em uma nova implantação/recriação do contêiner.

Faça backups regulares pela seção Backup da aba Gestor e guarde os arquivos fora do Railway. Antes de usar com dados reais, teste também o procedimento de restauração.

Se já existirem dados em um banco antigo fora do Volume, eles não são transferidos automaticamente para `/data`; faça backup e migração antes de trocar o caminho.

## Teste local

Requer Node.js 22.

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` carrega o arquivo `.env`. O comando de produção é `npm start` e utiliza as variáveis configuradas no ambiente.

`gerar-certificado.js` é apenas para testes HTTPS na rede local. Em produção, o Railway termina o HTTPS na borda.

## Limites e privacidade

- O contador de tentativas de PIN fica na memória e zera quando o serviço reinicia.
- O reconhecimento facial é calculado no celular e conferido no servidor; não há detecção de vivacidade (uma foto de tela pode enganar). O aparelho autorizado, o PIN e a foto de cada marcação reduzem o risco.
- O sistema não substitui, por si só, um sistema de registro de ponto homologado conforme a legislação aplicável. Fotos e dados faciais são dados pessoais sensíveis pela LGPD. Antes de usar com funcionários reais, providencie base legal adequada, transparência, regras de retenção e controles de acesso, além de revisão jurídica/trabalhista.
