# Frameleaf Connect para Zapier

Beta privada. Os acionadores, pesquisas, ações e ficheiros estão implementados; ainda são necessárias a qualificação alojada e a revisão do Zapier. Não publique este pacote.

A ligação pede library:read, library:download, albums:write, tags:write, photos:upload, boards:upload e events:read. No consentimento do Frameleaf, escolha os álbuns próprios exatos a ler e os álbuns ou espaços de trabalho onde escrever. Ler toda a Library é uma escolha explícita. Pessoas, partilha, remoção e eliminação nunca são pedidas.

O Zapier tem de aceder a um endereço HTTPS público da Library. HTTPS próprio não exige um plano Frameleaf Cloud; o relay Frameleaf exige um plano elegível. As subscrições e limites do Zapier são independentes. O acesso apenas por LAN não é suportado.

Obtenha no Zapier o endereço de retorno exato desta aplicação privada. Um administrador Frameleaf regista-o no Connect e fornece o ID de cliente não secreto. Introduza a origem canónica do servidor e o ID e conclua o consentimento no navegador. Nunca cole tokens num campo de um Zap.

Os acionadores de eventos verificam os 1000 eventos correspondentes mais recentes em cada consulta. Se houver mais de 1000 eventos entre duas consultas, os mais antigos são omitidos; não é uma sincronização sem perdas.

As ações que criam algo exigem um ID de origem que se mantenha igual para o mesmo item, como o ID do passo anterior. Assim, repetições, novas tentativas e execuções simultâneas criam um único álbum ou ficheiro, sem duplicados.

Os ficheiros só são obtidos quando um passo posterior os usa, com o acesso atual da ligação. Revogar o acesso nas aplicações ligadas do Frameleaf impede mais ficheiros; não remove as cópias já enviadas para outro local. Remover a ligação do Zapier não revoga a autorização do Frameleaf.

Antes da publicação, qualifique a aplicação alojada: OAuth no navegador com o retorno real, vários Zaps simultâneos a partilhar uma ligação que expira e a produzir uma única rotação segura, uma resposta de renovação perdida, a revogação e cada acionador, pesquisa, ação e ficheiro com uma Library de teste.
