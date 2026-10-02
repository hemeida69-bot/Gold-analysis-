# تحليل الدهب اليومي

1. اعمل ريبو جديد على GitHub (Public) وارفع كل الملفات، بما فيها مجلد `.github/workflows/update.yml`.
2. من Settings > Secrets and variables > Actions أضف سرّين:
   - `ALPHAVANTAGE_API_KEY` (مفتاح مجاني من alphavantage.co)
   - `ANTHROPIC_API_KEY` (من console.anthropic.com)
3. من Settings > Pages اختار Source: **GitHub Actions**.
4. من تبويب Actions شغّل **Update gold analysis** يدوياً مرة (Run workflow).
5. افتح الرابط `https://USERNAME.github.io/REPO/` على Safari، ثم Share > Add to Home Screen.

بعد كده بيتحدث لوحده كل يوم عمل الساعة 5 صباحاً UTC. لتغيير النموذج ضيف متغير `CLAUDE_MODEL`.
