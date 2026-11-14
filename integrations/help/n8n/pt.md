# Ligar Frameleaf ao n8n

Use uma instalação n8n alojada por si, no modo normal e com um único processo. O modo de fila, vários workers e n8n Cloud não são suportados. A interface do nó n8n está em inglês.

1. Instale o nó comunitário Frameleaf e adicione uma credencial Frameleaf OAuth2 API.
2. Copie exatamente OAuth Redirect URL. Peça ao administrador da sua Library que a registe como cliente público PKCE com retorno HTTPS de confiança.
3. Introduza Library URL e o Client ID fornecido pelo administrador. Escolha o perfil mínimo de permissões e estabeleça a ligação.
4. Selecione separadamente os álbuns que podem ser lidos e os destinos de escrita. Volte a ligar após alterar o endereço ou as permissões.

O acesso direto por LAN ou HTTPS próprio não exige um plano Frameleaf Cloud. O acesso por relay exige um plano elegível. Mantenha ativas a validação de certificados e a proteção de rede do n8n; autorize apenas a sua Library quando necessário.

Para criar álbuns e carregar ficheiros, associe Source ID a um identificador estável do evento de origem. Os carregamentos também exigem uma Source Date estável. Preserve ID, data, nome, conteúdo e destino nas novas tentativas. Aguarde o prazo Retry-After apresentado. Os ficheiros usam campos binários do n8n; as transferências têm um limite de tamanho configurável.

Os acionadores para novas fotografias, adições a álbuns e exportações do Studio chegarão numa versão futura. Até lá, inicie os fluxos de trabalho com outro acionador, como um agendamento ou um webhook.

Para desligar, revogue o acesso no Frameleaf e elimine a credencial n8n. As cópias já guardadas noutros locais permanecem. Contacte support@frameleaf.app com a operação e o estado HTTP, sem credenciais, nomes de ficheiros privados ou conteúdos multimédia.
