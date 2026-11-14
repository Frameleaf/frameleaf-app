# Publicar a partir do Lightroom Classic

1. Transfira o ZIP do plugin do Frameleaf, descompacte-o e, no Lightroom Classic, escolha **File → Plug-in Manager → Add**. Selecione `frameleaf.lrplugin`.
2. No painel **Publish Services**, clique em **Set Up** junto ao Frameleaf. Introduza o endereço da sua biblioteca, por exemplo `https://photos.example.com` ou `http://192.168.1.20:2283`. Deixe **ID da aplicação** vazio, a não ser que o seu administrador tenha registado o Lightroom por si.
3. Clique em **Ligar…**. O seu navegador abre o Frameleaf. Inicie sessão, escolha os álbuns a que o Lightroom pode acrescentar fotografias e permita criar novos álbuns se quiser que cada coleção tenha o seu próprio álbum. Quando o navegador voltar ao Lightroom, a caixa de diálogo mostra **Ligado**.
4. Crie uma coleção publicada. Nas definições da coleção, escolha um álbum Frameleaf existente ou deixe **Criar um novo álbum**. Arraste fotografias para lá e clique em **Publish**.

O Lightroom envia JPEG sRGB com título, legenda, palavras-chave e direitos de autor. A localização é removida, a menos que assinale **Incluir localização**, e as etiquetas de pessoas nunca são enviadas. Assinale **Adicionar as palavras-chave do Lightroom como etiquetas do Frameleaf** antes de ligar, para também etiquetar as fotografias no Frameleaf.

O Frameleaf guarda todas as cópias que publicar. Voltar a publicar uma fotografia editada acrescenta uma nova cópia junto à anterior. Remover uma fotografia ou uma coleção no Lightroom nunca remove nada do Frameleaf.

Ligar a partir da sua rede doméstica ou do seu próprio endereço HTTPS não requer um plano Frameleaf Cloud. Ligar através do relay do Frameleaf requer um plano que inclua acesso remoto.

Se o Lightroom indicar que a ligação terminou, abra as definições do serviço de publicação e clique novamente em **Ligar…**. **Desligar** termina a sessão do Lightroom e remove o seu acesso no Frameleaf; também pode remover o Lightroom no Frameleaf em **Definições › O seu início de sessão e privacidade › Aplicações ligadas**.
