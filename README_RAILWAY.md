# PontoLink — Railway

Controle de ponto com PIN, foto e reconhecimento facial. Roda como um único serviço Node.js, com **SQLite e fotos em um Volume** do Railway (o app não usa o Postgres do Railway).

## Publicar

1. Envie esta pasta para um repositório privado no GitHub (renomeie os arquivos de ponto no início, se o upload os alterou: `.gitignore` e `.env.example`).
2. No Railway: **New Project → Deploy from GitHub Repo**.
3. No serviço, adicione um **Volume** montado em `/data`.
4. Em **Variables**:
   - `NODE_ENV=production`
   - `DATA_DIR=/data`
   - `ADMIN_PIN` = PIN inicial só com números, de 8 a 12 dígitos
   - `FACE_THRESHOLD=0.5` (opcional)
5. Gere o domínio público do serviço e abra `/health` para conferir.

> Não apague nem recrie o Volume depois de cadastrar funcionários: é lá que ficam `ponto.db` e `photos/`.

## Primeiro uso

1. No celular da loja, abra o endereço do Railway. Aparece **"Autorizar este aparelho"**.
2. Dê um nome (ex.: Celular do balcão) e digite o PIN do gestor. Só aparelhos autorizados listam funcionários e registram ponto.
3. Na aba **Gestor**: cadastre os funcionários e o rosto de cada um.
4. Em **Aparelhos autorizados** dá para revogar um celular perdido ou trocado.

## Backup (faça toda semana)

Na aba Gestor, seção **Backup**: baixe o banco e as fotos e guarde fora do Railway (Drive ou HD externo). Teste restaurar uma vez antes de usar com dados reais.

## Teste local

```bash
npm install
cp .env.example .env
npm run dev
```

Use `npm run dev` (ele lê o `.env`). Em desenvolvimento, `REQUIRE_DEVICE=false` libera o registro sem autorizar o aparelho; em produção isso é sempre exigido. `gerar-certificado.js` é só para testar em rede local, nunca em produção.

## Limites conhecidos

- O contador de tentativas de PIN fica na memória e zera quando o serviço reinicia.
- O reconhecimento facial é calculado no celular e conferido no servidor; não há detecção de "pessoa viva" (uma foto de tela pode enganar). O aparelho autorizado, o PIN e a foto de cada marcação reduzem o risco.
- Não substitui um sistema homologado pela Portaria MTP 671/2021. Fotos e dados faciais são dados pessoais sensíveis (LGPD): antes de usar com funcionários reais, tenha termo de consentimento, regra de retenção e revisão jurídica/trabalhista.
