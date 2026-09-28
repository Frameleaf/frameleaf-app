---
sidebar_position: 70
---

# Unraid [ Community ]

:::note
This is a community contribution and not officially supported by Frameleaf, but included here for convenience.
:::

Frameleaf installs on Unraid with the [Docker Compose Manager](https://forums.unraid.net/topic/114415-plugin-docker-compose-manager/) plugin from the Unraid Community Apps.

:::info
The Unraid Community Apps templates use community images of other software, not Frameleaf. Use the Docker Compose method below.
:::

## Docker-Compose Method

:::info

- Guide was written using Unraid v6.12.10.
- Requires you to have installed the plugin: [Docker Compose Manager](https://forums.unraid.net/topic/114415-plugin-docker-compose-manager/)
- An Unraid share created for your images
- There has been a [report](https://forums.unraid.net/topic/130006-errortraps-traps-node27707-trap-invalid-opcode-ip14fcfc8d03c0-sp7fff32889dd8-more/#comment-1189395) of this not working if your Unraid server doesn't support AVX _(e.g. using a T610)_

:::

Use the Compose files and images from a [Frameleaf release](https://github.com/Frameleaf/frameleaf-app/releases). Keep an existing stack name, `.env`, database directory and media paths when updating. The container display names are `frameleaf_*`; the Compose service names and `IMMICH_*` variables remain compatible.

## Installation Steps

1. Go to "**Plugins**" and click on "**Compose.Manager**"
2. Click "**Add New Stack**" and when prompted for a label enter "**Frameleaf**", then click "**OK**"
3. Select the cogwheel ⚙️ next to Frameleaf and click "**Edit Stack**"
4. Click "**Compose File**" and then paste the entire contents of the [Frameleaf Docker Compose](https://github.com/Frameleaf/frameleaf-app/releases/latest/download/docker-compose.yml) file into the Unraid editor. Remove any text that may be in the text area by default. Note that Unraid v6.12.10 uses version 24.0.9 of the Docker Engine, which does not support healthcheck `start_interval` as defined in the `database` service of the Docker compose file (version 25 or higher is needed). This parameter defines an initial waiting period before starting health checks, to give the container time to start up. Commenting out the `start_interval` and `start_period` parameters will allow the containers to start up normally. The only downside to this is that the database container will not receive an initial health check until `interval` time has passed.

   <details >
       <summary>Using an existing Postgres container? Click me! Otherwise proceed to step 5.</summary>
       <ul>
           <li>Comment out the whole <code>database</code> service, from the <code>database:</code> line to its <code>restart:</code> line</li>
           <li>Comment out the <code>- database</code> entry under <code>depends_on:</code> for <b>each service</b> that lists it. If <code>database</code> is the only entry, comment out the <code>depends_on:</code> line as well</li>
           <li>Comment out the volumes</li>
           <img
               src={require('./img/unraid04.webp').default}
               width="20%"
               alt="Comment out database volume"
           />
       </ul>
   </details>

5. Click "**Save Changes**", you will be prompted to edit stack UI labels, just leave this blank and click "**Ok**"
6. Select the cog ⚙️ next to Frameleaf, click "**Edit Stack**", then click "**Env File**"
7. Paste the entire contents of the [Frameleaf example.env](https://github.com/Frameleaf/frameleaf-app/releases/latest/download/example.env) file into the Unraid editor, then **before saving** edit the following:
   - `UPLOAD_LOCATION`: Create a folder in your Images Unraid share and place the **absolute** location here > For example my _"images"_ share has a folder within it called _"frameleaf"_. If I browse to this directory in the terminal and type `pwd` the output is `/mnt/user/images/frameleaf`. This is the exact value I need to enter as my `UPLOAD_LOCATION`
   - `DB_DATA_LOCATION`: Change this to use an Unraid share (preferably a cache pool, e.g. `/mnt/user/appdata/postgresql/data`). This uses the `appdata` share. Do also create the `postgresql` folder, by running `mkdir /mnt/user/{share_location}/postgresql/data`. If left at default it will try to use Unraid's `/boot/config/plugins/compose.manager/projects/[stack_name]/postgres` folder which it doesn't have permissions to, resulting in this container continuously restarting.

   <details >
       <summary>Using an existing Postgres container? Click me! Otherwise proceed to step 8.</summary>
       <p>Update the following database variables as relevant to your Postgres container:</p>
       <ul>
           <li><code>DB_HOSTNAME</code></li>
           <li><code>DB_USERNAME</code></li>
           <li><code>DB_PASSWORD</code></li>
           <li><code>DB_DATABASE_NAME</code></li>
           <li><code>DB_PORT</code></li>
       </ul>
   </details>

8. Click "**Save Changes**" followed by "**Compose Up**" and Unraid will begin to create the Frameleaf containers in a popup window. Once complete you will see a message on the popup window stating _"Connection Closed"_. Click "**Done**" and go to the Unraid "**Docker**" page

   > Note: This can take several minutes depending on your Internet speed and Unraid hardware

9. Once on the Docker page you will see several Frameleaf containers, one of them will be labelled `frameleaf_server` and will have a port mapping. Visit the `IP:PORT` displayed in your web browser and you should see the Frameleaf admin setup page.
   For example, if the port mapping for `frameleaf_server` reads `172.18.0.7:2283/TCP ↔ 192.168.0.25:2283`, open `http://192.168.0.25:2283`.

<details >
    <summary>Using the FolderView plugin for organizing your Docker containers? Click me! Otherwise you're complete!</summary>
    <p>If you are using the FolderView plugin go the Docker tab and select "<b>New Folder</b>".<br />Label it <i>"Frameleaf"</i> and use this URL as the logo: https://raw.githubusercontent.com/Frameleaf/frameleaf-app/refs/heads/fork/main/web/static/favicon.png<br/>Then turn on the toggle for each Frameleaf related container before clicking "<b>Submit</b>". The Docker page then groups them under a single collapsible Frameleaf folder.</p>

</details>

:::tip
For more information on how to use the application once installed, see the [Post Install](/install/post-install.mdx) guide.
:::

## Updating Steps

:::danger
Make sure to read the general [upgrade instructions](/install/upgrading.md).
:::

Updating is extremely easy however it's important to be aware that containers managed via the Docker Compose Manager plugin do not integrate with Unraid's native dockerman UI, the label "_update ready_" will always be present on containers installed via the Docker Compose Manager.

You should ignore the "_update ready_" on the Unraid WebUI and update when Frameleaf tells you a new version is available. Read the release notes for that version before you update.

1. Go to the "**Docker**" tab and scroll to the Compose section
2. Next to Frameleaf click the "**Update Stack**" button and Unraid will begin to update all Frameleaf related containers
   > Note: **Do not** select Compose Down first, it is unnecessary.
3. The "**Update Stack**" window lists each container as it is pulled and restarted. Once complete you will see a "_Connection Closed_" message, select "**Done**".
4. Return to the Frameleaf WebUI and confirm that the server version it reports is the version you updated to.
