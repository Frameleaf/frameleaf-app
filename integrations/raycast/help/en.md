# Use Frameleaf in Raycast

1. Install the Frameleaf extension in Raycast and open **Search Photos** or **Browse Albums**.
2. Enter your Library address, for example `https://photos.example.com`. Plain HTTP works only for addresses on your own network, such as `http://192.168.1.20:2283`; sign-in and photos then travel unencrypted on that network.
3. Sign in to your Library in the browser and choose the albums Raycast can read, or allow your whole library. Return to Raycast.

Select a photo to see a preview. From the action panel you can open it in Frameleaf, copy the image or its link, or download it. Downloads are large JPEGs without location or camera details and never replace an existing file.

To download originals, turn on **Original downloads** in the extension preferences. Your Library asks you to allow it the next time you connect; on any photo, choose **Allow Original Downloads** to connect again. Originals keep their location and camera details.

A direct connection doesn’t need a Frameleaf Cloud plan; Frameleaf relay follows your Cloud plan. If your Library doesn’t let apps register themselves, ask its administrator to register the return address `https://raycast.com/redirect?packageName=Extension` and enter the Client ID in the extension preferences.

Raycast can’t see people, locations, sharing or other albums, and can’t change or delete anything. Change its albums under **Connected apps** in your Library’s settings. **Disconnect Library** revokes access; if your Library can’t be reached, Raycast keeps its sign-in so you can try again. Photos you already downloaded stay on your computer.
