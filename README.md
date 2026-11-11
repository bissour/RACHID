# RACHID

## DataSaisie — application de saisie, d'analyse et de visualisation de données

Application web 100 % navigateur (aucun serveur, aucune installation), dans le dossier [`app/`](app/).
Les données restent sur votre poste (sauvegarde automatique dans le navigateur) et l'application fonctionne hors ligne.

### Lancer l'application
- Ouvrir `app/index.html` dans un navigateur (Chrome, Firefox, Edge), **ou**
- servir le dépôt : `python3 -m http.server` puis aller sur `http://localhost:8000/app/`, **ou**
- activer GitHub Pages sur le dépôt et ouvrir `…/app/`.

### Fonctionnalités
| Onglet | Ce qu'il permet |
|---|---|
| ✏️ **Saisie** | Définir les colonnes (texte / nombre / date), les renommer, réordonner, supprimer ; formulaire de saisie généré automatiquement avec suggestions. |
| 📋 **Données** | Import CSV / TSV / TXT, JSON (y compris JSON « approximatif », `{data:[…]}`, NDJSON), GeoJSON, Excel (xlsx/xls/ods), ou texte collé depuis Excel ; mode remplacer / ajouter ; tableau éditable (double-clic), tri, recherche, pagination, suppression de lignes ; export CSV, JSON, Excel. |
| ⚙️ **Traitement** | Conversion de types (nettoyage « $320,800 », « 1 234,5 € », dates JJ/MM ou MM/JJ), valeurs manquantes (suppression, valeur, moyenne, médiane, mode, valeur précédente), doublons, filtres, rechercher/remplacer, nettoyage de texte, colonnes calculées (`[Prix] * [Quantité]`), tri, discrétisation en classes. Journal des opérations. |
| 📈 **Analyse** | Statistiques descriptives par colonne (min, quartiles, médiane, moyenne, écart-type, somme, manquants…), regroupements / tableaux croisés, tables de fréquences, matrice de corrélation. |
| 📊 **Visualisation** | Barres, barres horizontales, courbes, secteurs, anneau, nuage de points, histogramme ; agrégation, tri, limite ; export PNG. |

Toutes les modifications sont annulables (↶ Annuler / Ctrl+Z, ↷ Rétablir / Ctrl+Y).

Bibliothèques embarquées (`app/vendor/`) : [Chart.js](https://www.chartjs.org/) 4.4.1 (MIT) et [SheetJS](https://sheetjs.com/) 0.18.5 (Apache-2.0).
