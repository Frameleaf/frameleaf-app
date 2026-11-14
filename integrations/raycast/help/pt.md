# Utilizar o Frameleaf no Raycast

1. Instale a extensão Frameleaf no Raycast e abra **Search Photos** ou **Browse Albums**.
2. Introduza o endereço da sua Library, por exemplo `https://photos.example.com`. O HTTP simples só funciona com endereços da sua própria rede, como `http://192.168.1.20:2283`; nesse caso, o início de sessão e as fotografias circulam sem encriptação nessa rede.
3. Inicie sessão na sua Library no navegador e escolha os álbuns que o Raycast pode ler, ou permita toda a biblioteca. Volte ao Raycast.

Selecione uma fotografia para ver uma pré-visualização. No painel de ações, pode abri-la no Frameleaf, copiar a imagem ou a ligação, ou transferi-la. As transferências são JPEG grandes sem localização nem dados da câmara e nunca substituem um ficheiro existente.

Para transferir originais, ative **Original downloads** nas preferências da extensão. A sua Library pedirá autorização na próxima ligação; em qualquer fotografia, escolha **Allow Original Downloads** para voltar a ligar. Os originais mantêm a localização e os dados da câmara.

Uma ligação direta não precisa de um plano Frameleaf Cloud; o relay Frameleaf segue o seu plano Cloud. Se a sua Library não permitir que as aplicações se registem sozinhas, peça ao administrador para registar o endereço de retorno `https://raycast.com/redirect?packageName=Extension` e introduza o ID de cliente nas preferências da extensão.

O Raycast não vê pessoas, localizações, partilhas nem outros álbuns, e não pode alterar nem eliminar nada. Altere os álbuns em **Aplicações ligadas**, nas definições da sua Library. **Disconnect Library** revoga o acesso; se a sua Library não estiver acessível, o Raycast mantém a sessão para que possa tentar novamente. As fotografias já transferidas permanecem no seu computador.
