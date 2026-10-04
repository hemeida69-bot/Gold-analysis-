# XAUUSD Desk

لوحة تحليل للدهب (XAUUSD الفوري) على GitHub Pages، بتتحدث لوحدها بـGitHub Actions. من غير سيرفر ومن غير تكلفة.

## الصفحات
Dashboard · Liquidity Map · No Trade Zone · Trading Sessions · Signal Performance

## البيانات (كلها مصادر مفتوحة)
- سعر XAUUSD الفوري: gold-api.com، بيتسجل كل ساعة في `spot.json` (تاريخ إغلاقات الساعة بيتبني ذاتياً).
- العوائد والعائد الحقيقي: خزانة أمريكا. الفائدة الفعلية: بنك نيويورك الفيدرالي. التضخم: BLS. الدولار DXY: Yahoo.

## الملفات
- `update.py`: التحديث الدوري (السعر، الاتجاه الكلي، الإشعارات). `xau.py`: السيولة والجلسات و"متى لا تتداول".
- `index.html`: الواجهة. بتقرأ `live.json` و`data.json` و`xau.json`.
- `.github/workflows/update.yml`: كل ساعة (الأحد-الجمعة) تحديث سريع، ويوم عمل 05:00 UTC تحديث كامل.

## الإعداد
- Pages: Settings > Pages > Source: GitHub Actions.
- إشعارات ntfy: Secret اسمه `NTFY_TOPIC`. للإشعار مع كل تحديث: Variable `NOTIFY_ALL=true`.
- تحليل Claude (اختياري، بأخبار وتقويم): Secret `ANTHROPIC_API_KEY`. من غيره بيشتغل بقواعد ثابتة.

المحتوى للمعلومات فقط وليس نصيحة استثمارية.
