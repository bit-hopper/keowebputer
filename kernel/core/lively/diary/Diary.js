/**
 * lively.diary.Diary
 *
 * Stub for the "Diary" world template (see
 * core/lively/identity/WorldTemplateLauncher.js): a preset a user picks from
 * WorldsBrowser.js's create-world flow, which opens this morph in the fresh
 * world. For now it is just a titled card saying so; the entries themselves
 * are not built yet.
 *
 * Entry point:
 *   lively.diary.Diary.open(optWorldPosition)
 */

module("lively.diary.Diary")
  .requires()
  .toRun(function () {
    var WIDTH = 460;
    var HEIGHT = 220;
    var PINK = Color.rgb(240, 26, 105);

    Object.extend(lively.diary.Diary, {
      open: function open(optPos) {
        var card = new lively.morphic.Box(lively.rect(0, 0, WIDTH, HEIGHT));
        card.setName("Diary");
        card.applyStyle({
          fill: Color.white,
          borderWidth: 1,
          borderColor: PINK,
          borderRadius: 14,
        });

        // fontSize is in points; pass px * 0.75 for a real px size
        var title = new lively.morphic.Text(lively.rect(28, 28, WIDTH - 56, 40), "Diary");
        title.setName("DiaryTitle");
        title.applyStyle({
          allowInput: false,
          fill: null,
          borderWidth: 0,
          borderColor: null,
          fontSize: 28 * 0.75,
          fontWeight: "bold",
          textColor: Color.rgb(40, 40, 40),
        });
        card.addMorph(title);

        var note = new lively.morphic.Text(lively.rect(28, 84, WIDTH - 56, 60), "Your diary will live here. Entries are not built yet.");
        note.setName("DiaryNote");
        note.applyStyle({
          allowInput: false,
          fill: null,
          borderWidth: 0,
          borderColor: null,
          fontSize: 14 * 0.75,
          textColor: Color.rgb(110, 110, 110),
        });
        card.addMorph(note);

        var world = lively.morphic.World.current();
        card.openInWorld(optPos || world.visibleBounds().center().subPt(lively.pt(WIDTH / 2, HEIGHT / 2)));
        return card;
      },
    });
  }); // end module('lively.diary.Diary')
