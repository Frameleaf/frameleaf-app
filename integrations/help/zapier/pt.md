# Frameleaf Connect para Zapier

Inclui apenas a base de ligação. Ações, pesquisas, ficheiros e acionadores ainda não estão disponíveis. Não publique este pacote nem o utilize em produção.

Esta ligação de qualificação pede apenas library:read. Selecione os seus álbuns exatos no consentimento Frameleaf; a leitura de toda a biblioteca exige uma escolha explícita. Não pede originais, pessoas ou escrita.

O Zapier tem de aceder a um endereço HTTPS público da Library. HTTPS próprio não exige um plano Frameleaf Cloud; o relay Frameleaf exige um plano elegível. As subscrições e limites do Zapier são independentes. O acesso apenas por LAN não é suportado.

Obtenha no Zapier o endereço de retorno exato desta aplicação privada. Um administrador Frameleaf regista-o no Connect e fornece o ID de cliente não secreto. Introduza a origem canónica do servidor e o ID e conclua o consentimento no navegador. Nunca cole tokens num campo de um Zap.

OAuth alojado e renovações simultâneas têm de ser qualificados antes de adicionar funcionalidades. Confirme que vários Zaps com uma ligação partilhada realizam uma só rotação segura, guardam todos os novos tokens, preservam as credenciais após uma resposta incerta e revogam corretamente. Este código não comprova esses comportamentos da plataforma.
