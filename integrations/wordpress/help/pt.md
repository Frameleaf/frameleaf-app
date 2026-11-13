# Importar imagens do Frameleaf

1. Instale e ative o ZIP Frameleaf Connect no WordPress.
2. Como administrador, abra **Multimédia → Frameleaf** e adicione a origem HTTPS da sua Library. Permita a rede privada apenas para a sua Library. Se o registo automático estiver desativado, registe o endereço de retorno exato apresentado no Frameleaf Connect e introduza o ID de cliente.
3. Cada editor escolhe **Ligar ao Frameleaf** e autoriza os álbuns selecionados. O endereço de retorno do WordPress exige HTTPS com certificado de confiança.
4. No seletor multimédia do Gutenberg ou do editor clássico, escolha **Frameleaf**. Explore um álbum ou pesquise, aceite a cópia local e importe a imagem. Edite a legenda e o texto alternativo nos controlos do WordPress.

As imagens JPEG, PNG e WebP importadas tornam-se anexos normais do WordPress com a visibilidade do site. Permanecem após desligar ou revogar o acesso. Não há sincronização nem eliminação em segundo plano. Uma nova importação transfere a versão atual para comparar o SHA-256: conteúdo idêntico reutiliza o anexo; conteúdo alterado cria outra cópia.

O servidor WordPress deve alcançar a Library e confiar no certificado. HTTPS local ou fornecido pelo cliente não exige um plano Frameleaf Cloud; o relay Frameleaf exige o plano existente. Os ficheiros devem respeitar o limite WordPress e o limite do plugin de 16 MiB / 40 megapíxeis.

Se não houver ligação, verifique o endereço e o certificado e volte a ligar-se. Uma renovação incerta exige nova ligação. Ao desligar, a revogação é repetida e as credenciais cifradas são conservadas até ao sucesso. Após alterar chaves ou salts do WordPress, revogue o acesso no Frameleaf, confirme aqui e escolha **Repor após uma alteração das chaves do WordPress**.

Uma importação falhada remove os dados temporários. Uma publicação interrompida com recibo incerto bloqueia duplicados automáticos. Peça ao administrador para verificar o anexo local e o registo pendente `frameleaf_imports` antes da recuperação. Nunca elimine registos pendentes sem os verificar. Apoio: support@frameleaf.app.

O Frameleaf requer PHP cURL com suporte HTTPS e uma ligação de rede direta à Library. Os pedidos à Library não utilizam proxies HTTP.
