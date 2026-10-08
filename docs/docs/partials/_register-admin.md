Open the photo application's address in your browser. On a new installation, follow **Get started** to create the first administrator account. Manager has a separate administrator account; use **Open Frameleaf setup** there to reach the photo application.

First setup requires the server's setup code. For a manual container installation, read it from the server log or display it with:

```sh
docker exec frameleaf_server frameleaf-admin setup-code
```

Enter the code and follow the name, email and password prompts. An imported library may already have an administrator: sign in with that account instead of creating another one. After sign-in, review the onboarding and processing settings before starting a large import.
