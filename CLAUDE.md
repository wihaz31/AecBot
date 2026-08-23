# AecBot

Türkçe konuşan bir Discord botu. Tek dosyada toplanmış: `index.js`.

## Git akışı (ÖNEMLİ)

Geliştirme `claude/number-guessing-game-UpLbX` dalında yapılır, **ama sunucu
`main`'den çektiği için her değişiklik iki dala da gitmelidir.**

Her iş bitiminde sırasıyla:

```bash
git add -A && git commit -m "..."
git push -u origin claude/number-guessing-game-UpLbX
git checkout main && git merge --ff-only claude/number-guessing-game-UpLbX
git push -u origin main
git checkout claude/number-guessing-game-UpLbX
```

Fast-forward bozulursa (main ileri gitmişse) feature dalını `main` üzerine
rebase et, sonra tekrar dene. Merge commit üretme.

Geçmişte bu adım atlandığı için 32 commit `main`'e hiç ulaşmamış ve bot
aylarca eski kodla çalışmıştı — bu yüzden `main` push'u opsiyonel değil.

## Dağıtım

Hetzner'da PM2 ile çalışıyor. Kullanıcı sunucuda `~/update.sh` çalıştırır;
script `main`'den pull yapıp botu yeniden başlatır.

Bilinen tuzaklar:
- Sunucuda takip edilmeyen `package-lock.json` varsa pull çakışır.
  Çözüm: `rm /root/AecBot/package-lock.json && ~/update.sh`
- Yeni bir npm paketi eklendiyse `update.sh` içinde `npm install` yoksa
  elle çalıştırılmalı, yoksa bot açılışta patlar.
- `canvas` sistem kütüphaneleri ister (`apt-get install` gerekebilir).

## Kalıcılık

Upstash Redis. Kayıtlı anahtarlar: `economy`, `inventory`, `birthdays`,
`guildConfig`, `seedMemory`, `roleMenus`, `bdaySent`.

Yazma işlemleri debounce'lu (`saveInventory`, `saveGuildConfig` vb.) —
doğrudan `redisSet` çağırmak yerine bu yardımcıları kullan.

## Yapı notları

- **Markov**: trigram. Anahtar `"kelime1 kelime2"`, değer `[kelime3, ...]`.
  Seed sunucu geçmişinden çekilir; 5 dakikalık pencerede aynı kişinin
  ardışık mesajları tek mesaj sayılır.
- **Görsel komutlar** (`/çark`, `/slot`): `canvas` + `gif-encoder-2` ile
  animasyonlu GIF üretir. MP4 kullanma — Discord'da kendiliğinden oynamıyor.
  Emoji için `NotoColorEmoji` fontu kayıtlı.
- **Müzik**: yt-dlp → play-dl → SoundCloud sırasıyla fallback'li.
  Spotify linkleri isim aramaya çevrilir (doğrudan stream mümkün değil).
- **Kick bildirimi**: REST API Cloudflare'e takıldığı için Pusher WebSocket
  kullanılıyor. `KICK_CHANNEL_ID` env değişkeni gerekir.
  Hedef kanal `/ayar kick` ile sunucu bazında ayarlanır.

## Dil

Kullanıcıya dönük tüm metinler Türkçe ve küçük harf ağırlıklı, samimi bir
tonda. Yeni komut eklerken mevcut mesajların üslubunu taklit et.
