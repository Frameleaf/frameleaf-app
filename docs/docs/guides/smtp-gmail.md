# SMTP settings using Gmail

This guide walks you through how to get the information you need to set up your Frameleaf instance to send emails using Gmail's SMTP server.

## Create an app password

From your Google account settings

- Add [2-Step Verification](https://support.google.com/accounts/answer/185839) to your Google account (Required)
- [Create an app password](https://myaccount.google.com/apppasswords).

At the end of creating your app passwords, a password will be displayed; save it, it will be used for the password field when setting up the SMTP server in Frameleaf.

<img src={require('./img/google-app-password.webp').default} title="Generated app password" />

## Entering the SMTP credential in Frameleaf

1. In Frameleaf, select **Settings** in the sidebar to open the Command Center.
2. Open **Notifications**, then **Email delivery**.
3. Turn on **Enable email notifications**.
4. Enter the following values:
   - **Host**: `smtp.gmail.com`
   - **Port**: `587`
   - **Username**: your full Gmail address
   - **SMTP password**: select **Replace credential** and enter the app password you created above
   - **SMTPS**: off
   - **Ignore certificate errors**: off
   - **From address**: a sender name and your Gmail address, for example `Frameleaf <you@gmail.com>`
5. Select **Send test email and save**. A successful test also saves your email settings.
