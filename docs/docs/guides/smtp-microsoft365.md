# SMTP settings using Microsoft 365

:::info Deprecated by Microsoft
Microsoft has announced the [deprecation](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835) of SMTP Basic Auth.
We no longer recommend using this setup method. Alternate methods are available but not within the scope of these docs.
:::

This guide walks you through how to get the information you need to set up your Frameleaf instance to send emails using Microsoft's SMTP server.

## Create an app password

You will need to generate an app password to use your Microsoft email in Frameleaf. Depending on if you have a personal or business account, you can use https://go.microsoft.com/fwlink/?linkid=2274139 or https://myaccount.microsoft.com/securtiy-info respectively.

## Entering the SMTP credential in Frameleaf

1. In Frameleaf, select **Settings** in the sidebar to open the Command Center.
2. Open **Notifications**, then **Email delivery**.
3. Turn on **Enable email notifications**.
4. Enter the following values:
   - **Host**: `smtp-mail.outlook.com`
   - **Port**: `587`
   - **Username**: your mail address
   - **SMTP password**: select **Replace credential** and enter the app password you created earlier
   - **SMTPS**: off
   - **From address**: a sender name and your mail address, for example `Frameleaf <mail@yourdomain.com>`
5. Select **Send test email and save**. A successful test also saves your email settings.
