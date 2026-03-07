/**
 * WHAT:
 * management.controller exposes read-only management handlers for student
 * result history and individual result packages.
 * WHY:
 * Management needs a dedicated controller boundary so reporting access stays
 * separate from teacher authoring and mentor support actions.
 * HOW:
 * Validate params in routes, call the management/result services, and return a
 * stable JSON response payload.
 */
const managementService = require("../services/management.service");
const resultService = require("../services/result.service");

async function getStudentResults(
  req,
  res,
  next,
) {
  try {
    const missions =
      await managementService.listStudentResults(
        {
          managementId: req.user.id,
          studentId: req.params.studentId,
        },
      );
    res.json({ missions });
  } catch (error) {
    next(error);
  }
}

async function getResultPackage(
  req,
  res,
  next,
) {
  try {
    const resultPackage =
      await resultService.getResultPackageForManagement(
        {
          managementId: req.user.id,
          resultPackageId: req.params.resultPackageId,
        },
      );
    res.json({ resultPackage });
  } catch (error) {
    next(error);
  }
}

async function createUser(
  req,
  res,
  next,
) {
  try {
    const user =
      await managementService.createManagedUser(
        {
          managementId: req.user.id,
          payload: req.body,
        },
      );
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
}

async function listSubjects(
  _req,
  res,
  next,
) {
  try {
    const subjects =
      await managementService.listSubjects();
    res.json({ subjects });
  } catch (error) {
    next(error);
  }
}

async function getSubjectCertificationSettings(
  req,
  res,
  next,
) {
  try {
    const certification =
      await managementService.getSubjectCertificationSettings(
        {
          subjectId: req.params.subjectId,
        },
      );
    res.json({ certification });
  } catch (error) {
    next(error);
  }
}

async function updateSubjectCertificationSettings(
  req,
  res,
  next,
) {
  try {
    const certification =
      await managementService.updateSubjectCertificationSettings(
        {
          subjectId: req.params.subjectId,
          payload: req.body,
        },
      );
    res.json({ certification });
  } catch (error) {
    next(error);
  }
}

async function getStudentCertification(
  req,
  res,
  next,
) {
  try {
    const certifications =
      await managementService.getStudentCertification(
        {
          managementId: req.user.id,
          studentId: req.params.studentId,
        },
      );
    res.json({
      certifications,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createUser,
  getStudentResults,
  getResultPackage,
  getStudentCertification,
  getSubjectCertificationSettings,
  listSubjects,
  updateSubjectCertificationSettings,
};
