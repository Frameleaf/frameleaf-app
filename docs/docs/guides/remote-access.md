# Remote Access

This page gives a few pointers on how to access your Frameleaf instance from outside your LAN.
You can read the [full discussion in Discord](https://discord.com/channels/979116623879368755/1122615710846308484)

:::danger
Never forward port 2283 directly to the internet without additional configuration. This will expose the web interface via http to the internet, making you susceptible to [man in the middle](https://en.wikipedia.org/wiki/Man-in-the-middle_attack) attacks.
:::

## Frameleaf Cloud remote access

With a Frameleaf Cloud plan that includes remote access, a linked server can be reached from anywhere without a VPN, a port you open by hand or a certificate you manage. Turn it on in Settings → Frameleaf Cloud → **Remote access**.

- **Its own address.** The server gets a name under Frameleaf's direct domain, such as `https://r.<label>.frameleaf.net`, shown on the Remote access page with a QR code. On the home network the apps use its LAN name, `https://192-168-1-10.<label>.frameleaf.net:2443`, which reaches the server directly over HTTPS.
- **Its own certificate.** The server obtains and renews a Let's Encrypt certificate for its names itself. Frameleaf Cloud only publishes the DNS challenge values the server gives it; the certificate's private key never leaves your server.
- **Connection.** **Relay only** carries every remote connection through the Frameleaf relay, which never sees inside the encrypted connection. **Relay and direct** also accepts direct connections on the external port (2443 by default); forward it on your router with **I forward the port myself** if the router does not open it automatically.
- **Your own domain.** Under **Use your own domain**, enter a subdomain you own, such as `photos.example.com`, add the two CNAME records the page shows at your DNS provider (`photos.example.com` → `r.<label>.frameleaf.net` and `_acme-challenge.photos.example.com` → `_acme-challenge.<label>.frameleaf.net`), then **Check DNS**. Once verified, the server obtains a certificate for your hostname too, and **Use my domain** makes it the address the server publishes.
- **Who can connect.** Everyone connecting from outside your home signs in with a Frameleaf account linked to their account here. Public shared links still open without signing in. Original downloads and password sign-in stay off over the relay unless you turn them on.

**Test connection** checks the certificate and a request through the HTTPS listener. See [Workers and endpoints](/administration/workers-and-endpoints#the-edge-worker-remote-access) for how the edge worker serves remote access, and [Frameleaf Cloud](/administration/frameleaf-cloud#remote-access-security) for the sign-in and download rules.

The options below work without Frameleaf Cloud.

## Option 1: VPN to home network

You may use a VPN service to open an encrypted connection to your Frameleaf instance. OpenVPN and Wireguard are two popular VPN solutions. Here is a guide on setting up VPN access to your server - [Pihole documentation](https://docs.pi-hole.net/guides/vpn/wireguard/overview/)

### Pros

- Simple to set up and very secure.
- Single point of potential failure, i.e., the VPN software itself. Even if there is a zero-day vulnerability on Frameleaf, you will not be at risk.
- Both Wireguard and OpenVPN are independently security-audited, so the risk of serious zero-day exploits are minimal.

### Cons

- If you don't have a static IP address, you would need to set up a [Dynamic DNS](https://www.cloudflare.com/learning/dns/glossary/dynamic-dns/). [DuckDNS](https://www.duckdns.org/) is a free DDNS provider.
- VPN software needs to be installed and active on both server-side and client-side.
- Requires you to open a port on your router to your server.

## Option 2: Tailscale

If you are unable to open a port on your router for Wireguard or OpenVPN to your server, [Tailscale](https://tailscale.com/) is a good option. Tailscale mediates a peer-to-peer wireguard tunnel between your server and remote device, even if one or both of them are behind a [NAT firewall](https://en.wikipedia.org/wiki/Network_address_translation).

:::tip Video tutorial
You can learn how to set up Tailscale together with Frameleaf with the [tutorial video](https://www.youtube.com/watch?v=Vt4PDUXB_fg) they created.
:::

### Pros

- Minimal configuration needed on server and client sides.
- You are protected against zero-day vulnerabilities on Frameleaf.

### Cons

- The Tailscale client usually needs to run as root on your devices and it increases the attack surface slightly compared to a minimal Wireguard server. e.g., an [RCE vulnerability](https://github.com/tailscale/tailscale/security/advisories/GHSA-vqp6-rc3h-83cp) was discovered in the Windows Tailscale client in November 2022.
- Tailscale is a paid service. However, there is a generous [free tier](https://tailscale.com/pricing/) suitable for personal use.
- Tailscale needs to be installed and running on both server-side and client-side.

## Option 3: Reverse Proxy

A reverse proxy is a service that sits between web servers and clients. A reverse proxy can either be hosted on the server itself or remotely. Clients can connect to the reverse proxy via https, and the proxy relays data to Frameleaf. This setup makes most sense if you have your own domain and want to access your Frameleaf instance just like any other website, from outside your LAN. You can also use a DDNS provider like DuckDNS or no-ip if you don't have a domain. This configuration allows the Frameleaf Android and iphone apps to connect to your server without a VPN or tailscale app on the client side.

If you're hosting your own reverse proxy, [Nginx](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/) is a great option. An example configuration for Nginx is provided [here](/administration/reverse-proxy.md).

You'll also need your own certificate to authenticate https connections. If you're making Frameleaf publicly accessible, [Let's Encrypt](https://letsencrypt.org/) can provide a free certificate for your domain and is the recommended option. Alternatively, a [self-signed certificate](https://en.wikipedia.org/wiki/Self-signed_certificate) allows you to encrypt your connection to Frameleaf, but it raises a security warning on the client's browser.

A remote reverse proxy like [Cloudflare](https://www.cloudflare.com/learning/cdn/glossary/reverse-proxy/) increases security by hiding the server IP address, which makes targeted attacks like [DDoS](https://www.cloudflare.com/learning/ddos/what-is-a-ddos-attack/) harder.

### Pros

- No additional software needs to be installed client-side
- If you only need access to the web interface remotely, it is possible to set up access controls that shield you from zero-day vulnerabilities on Frameleaf. [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) has a generous free tier.

### Cons

- Complex configuration
- Depending on your configuration, both the Frameleaf web interface and API may be exposed to the internet. Frameleaf is under very active development and the existence of severe security vulnerabilities cannot be ruled out.
